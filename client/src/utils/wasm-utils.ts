import { useEffect, useRef } from 'react';
import * as wasm from '../wasm/iris_wasm';

type WasmObject = { free: () => void };

/**
 * Singleton WASM initialization.
 */
let wasmInitialized = false;
let wasmInitializing: Promise<void> | null = null;

export async function ensureWasmInitialized(): Promise<void> {
  if (wasmInitialized) return;
  if (wasmInitializing) return wasmInitializing;
  
  wasmInitializing = (async () => {
    await wasm.default();
    wasmInitialized = true;
  })();
  
  return wasmInitializing;
}

/**
 * Singleton GrpcClient per endpoint.
 * 
 * This prevents WASM closure errors by ensuring only one GrpcClient exists
 * per endpoint.
 * 
 */
const grpcClients = new Map<string, wasm.GrpcClient>();
const grpcClientPromises = new Map<string, Promise<wasm.GrpcClient>>();

export async function getGrpcClient(endpoint: string): Promise<wasm.GrpcClient> {
  // Return existing client if we have one
  const existing = grpcClients.get(endpoint);
  if (existing) return existing;
  
  // If we're already creating one, wait for it
  const inProgress = grpcClientPromises.get(endpoint);
  if (inProgress) return inProgress;
  
  // Create new client (only one creation per endpoint ever runs)
  const promise = (async () => {
    await ensureWasmInitialized();
    const client = new wasm.GrpcClient(endpoint);
    grpcClients.set(endpoint, client);
    grpcClientPromises.delete(endpoint);
    return client;
  })();
  
  grpcClientPromises.set(endpoint, promise);
  return promise;
}

/**
 * Manages WASM object lifecycle and prevents double-free
 */
export class WasmResourceManager {
  private objects: WasmObject[] = [];
  private freedObjects = new WeakSet<WasmObject>();

  /**
   * Register a WASM object for automatic cleanup
   */
  register<T extends WasmObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }

  /**
   * Register multiple WASM objects at once
   */
  registerAll<T extends WasmObject>(objects: T[]): T[] {
    objects.forEach(obj => this.objects.push(obj));
    return objects;
  }

  /**
   * Free all registered WASM objects in reverse order 
   */
  cleanup(): void {
    // Free in reverse order (dependencies first)
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const obj = this.objects[i];
      if (obj && !this.freedObjects.has(obj)) {
        try {
          obj.free();
        } catch {
          // Object likely already freed by a parent - ignore
        } finally {
          this.freedObjects.add(obj);
        }
      }
    }
    this.objects = [];
  }

  /**
   * Get the number of registered objects
   */
  get count(): number {
    return this.objects.length;
  }
}

/**
 * React hook for managing WASM object cleanup in components
 */
export function useWasmCleanup() {
  const managerRef = useRef<WasmResourceManager | null>(null);

  // Initialize manager on first render
  if (!managerRef.current) {
    managerRef.current = new WasmResourceManager();
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (managerRef.current) {
        managerRef.current.cleanup();
      }
    };
  }, []);

  return managerRef.current;
}

/**
 * Build a multisig SpendCondition from threshold and participant PKHs.
 * 
 * This is the canonical way to construct a multisig lock - used by both
 * WalletCreate (to compute lock_root_hash) and WalletList (to build transactions).
 * 
 * @param threshold - Number of signatures required (m in m-of-n)
 * @param participants - Array of PKH strings that can sign
 * @param cleanup - WasmResourceManager to register the SpendCondition for cleanup
 * @returns SpendCondition object
 */
export async function buildMultisigSpendCondition(
  threshold: number,
  participants: string[],
  cleanup?: WasmResourceManager
): Promise<wasm.SpendCondition> {
  await ensureWasmInitialized();
  
  // Create m-of-n PKH structure
  const multisigPkh = new wasm.Pkh(BigInt(threshold), participants);
  const lockPrimitive = wasm.LockPrimitive.newPkh(multisigPkh);
  const spendCondition = new wasm.SpendCondition([lockPrimitive]);
  
  // Register for cleanup if manager provided
  if (cleanup) {
    cleanup.register(spendCondition);
  }
  
  return spendCondition;
}

/**
 * Compute the lock_root_hash for a multisig wallet.
 * 
 * This is deterministic: same (threshold, participants) always produces
 * the same lock_root_hash.
 * 
 * @param threshold - Number of signatures required
 * @param participants - Array of PKH strings
 * @param cleanup - Optional WasmResourceManager for cleanup
 * @returns The lock_root_hash string (firstName of the SpendCondition)
 */
export async function computeLockRootHash(
  threshold: number,
  participants: string[],
  cleanup?: WasmResourceManager
): Promise<string> {
  const spendCondition = await buildMultisigSpendCondition(threshold, participants, cleanup);
  const firstName = spendCondition.firstName();
  const lockRootHash = firstName.value;
  
  // If no cleanup manager, free manually
  if (!cleanup) {
    firstName.free();
    spendCondition.free();
  } else {
    cleanup.register(firstName);
  }
  
  return lockRootHash;
}

/**
 * Build a simple PKH SpendCondition (single signer).
 * 
 * Used for querying a user's personal wallet notes and for input spend conditions.
 * 
 * @param pkh - The PKH digest string
 * @param cleanup - Optional WasmResourceManager for cleanup
 * @returns SpendCondition object
 */
export async function buildSimplePkhSpendCondition(
  pkh: string,
  cleanup?: WasmResourceManager
): Promise<wasm.SpendCondition> {
  await ensureWasmInitialized();
  
  const simplePkh = wasm.Pkh.single(pkh);
  const spendCondition = wasm.SpendCondition.newPkh(simplePkh);
  
  if (cleanup) {
    cleanup.register(spendCondition);
  }
  
  return spendCondition;
}

/**
 * Discover the correct spend condition for a note by matching lock-root to name.first
 * We try different candidate spend conditions and find which one matches.
 */
export async function discoverSpendConditionForNote(
  senderPKH: string,
  note: { nameFirst: string; originPage: number },
  cleanup?: WasmResourceManager
): Promise<wasm.SpendCondition> {
  await ensureWasmInitialized();

  // Try PKH-only first (most common for exchange-bought notes)
  const simpleCondition = await buildSimplePkhSpendCondition(senderPKH, cleanup);
  const simpleFirstName = simpleCondition.firstName().value;
  if (simpleFirstName === note.nameFirst) {
    return simpleCondition;
  }
  // Free simple condition if it doesn't match
  try { simpleCondition.free(); } catch (e) { /* ignore */ }

  // Try coinbase (PKH + timelock) if PKH-only doesn't match
  const pkhLeaf = wasm.LockPrimitive.newPkh(wasm.Pkh.single(senderPKH));
  const timLeaf = wasm.LockPrimitive.newTim(wasm.LockTim.coinbase());
  const coinbaseCondition = new wasm.SpendCondition([pkhLeaf, timLeaf]);
  
  const coinbaseFirstName = coinbaseCondition.firstName().value;
  if (coinbaseFirstName === note.nameFirst) {
    // Only register with cleanup if it matches
    if (cleanup) {
      cleanup.register(pkhLeaf);
      cleanup.register(timLeaf);
      cleanup.register(coinbaseCondition);
    }
    return coinbaseCondition;
  }
  // Free coinbase condition and its components if it doesn't match
  try { coinbaseCondition.free(); } catch (e) { /* ignore */ }
  try { pkhLeaf.free(); } catch (e) { /* ignore */ }
  try { timLeaf.free(); } catch (e) { /* ignore */ }

  throw new Error(
    `No matching spend condition for note.name.first (${note.nameFirst.slice(0, 20)}...). ` +
    `Cannot spend this UTXO. It may require a different lock configuration.`
  );
}

// ============================================================
// Transaction Building Utilities
// ============================================================



/**
 * Greedy coin selection algorithm for notes with assets.
 * Selects notes (largest first) until we have enough to cover amount + fee.
 */
export function selectNotesForAmount<T extends { assets: number }>(
  notes: T[],
  targetAmountNicks: number
): T[] | null {
  // Sort by assets descending (largest first)
  const sorted = [...notes].sort((a, b) => b.assets - a.assets);

  const selected: T[] = [];
  let total = 0;

  for (const note of sorted) {
    selected.push(note);
    total += note.assets;

    if (total >= targetAmountNicks) {
      return selected;
    }
  }

  // Not enough funds
  return null;
}

/**
 * Result of building an unsigned transaction.
 * 
 * The transaction is ready to be signed with IrisConnect SDK's signRawTx method.
 */
export interface UnsignedTransaction {
  /** The transaction ID (hash) */
  txId: string;
  /** Raw transaction protobuf (for signing) */
  rawTxProtobuf: any;
  /** Input notes protobufs (for signing) */
  notesProtobufs: any[];
  /** Input spend conditions protobufs (for signing) */
  spendConditionsProtobufs: any[];
  /** Actual calculated fee in nicks */
  actualFeeNicks: number;
  /** Actual calculated fee in NOCK */
  actualFeeNock: number;
}

/**
 * Input note for building a multisig spend transaction.
 */
export interface MultisigNoteInput {
  /** The note protobuf (from balance query) */
  protoNote: any;
  /** Assets in nicks */
  assets: number;
  /** The note's name.first (lock root hash) - used to verify spend condition */
  nameFirst?: string;
}


export interface NoteWithProto {
  protoNote: any;
  assets: number;
  originPage: number;
  nameFirst: string;
  nameLast?: string;
}

/**
 * Destination type for a transaction seed.
 * - 'wallet': A wallet address (PKH) - we derive the lock root via firstName()
 * - 'lockroot': A lock root hash directly - used as-is
 */
export type DestinationType = 'wallet' | 'lockroot';

/**
 * Extract the total fee from a raw transaction protobuf.
 * This mirrors how the Iris wallet extension calculates the fee.
 * 
 * @param rawTxProtobuf - The raw transaction protobuf object
 * @returns Total fee in nicks
 */
export function extractFeeFromRawTx(rawTxProtobuf: any): number {
  let totalFeeNicks = 0;
  try {
    if (rawTxProtobuf && rawTxProtobuf.spends && Array.isArray(rawTxProtobuf.spends)) {
      totalFeeNicks = rawTxProtobuf.spends.reduce((sum: number, spend: any) => {
        const feeValue = spend?.spend?.spend_kind?.Witness?.fee?.value;
        const fee = feeValue ? parseInt(feeValue, 10) : 0;
        return sum + (isNaN(fee) ? 0 : fee);
      }, 0);
    }
  } catch (err) {
    console.error('Error extracting fee from raw transaction:', err);
  }
  return totalFeeNicks;
}

/**
 * Seed (output) for a transaction.
 */
export interface TransactionSeed {
  /** How to interpret the destination */
  destinationType: DestinationType;
  /** Wallet address (PKH) or lock root hash */
  destination: string;
  /** Amount in NOCK */
  amountNock: number;
}

/**
 * Build an unsigned transaction for spending from a multisig wallet.
 * 
 * This function properly handles WASM object ownership:
 * - Creates fresh spend conditions for each SpendBuilder
 * - Gets note.hash() BEFORE passing note to SpendBuilder
 * - Registers all objects with cleanup manager
 * 
 * @param params - Transaction parameters
 * @returns Unsigned transaction ready for signing
 */
export async function buildUnsignedMultisigSpendTx(params: {
  threshold: number;
  participants: string[];
  selectedNotes: MultisigNoteInput[];
  seeds: TransactionSeed[];
  cleanup?: WasmResourceManager;
}): Promise<UnsignedTransaction> {

  await ensureWasmInitialized();

  const {
     threshold,
     participants,
     selectedNotes,
     seeds,
     cleanup
  } = params;

  if (selectedNotes.length === 0) {
    throw new Error('No notes selected for spending');
  }

  const validSeeds = seeds.filter(s => s.destination.trim() && s.amountNock > 0);
  if (validSeeds.length === 0) {
    throw new Error('No valid seeds (outputs) provided');
  }

  if (participants.length === 0) {
    throw new Error('No participants provided for multisig');
  }

  const feePerWord = BigInt(32768); // 0.5 NOCK per word

  // Calculate totals for validation
  const totalInputNicks = selectedNotes.reduce((sum, n) => sum + n.assets, 0);
  const totalOutputNicks = validSeeds.reduce((sum, s) => sum + Math.floor(s.amountNock * 65536), 0);
  
  
  // Conservative fee estimate for multisig: ~50 NOCK for 2-of-3, scales with participants
  // Multisig signatures are larger than single-sig
  const estimatedFeeNicks = Math.max(
    32768 * (10 + participants.length * 15 + selectedNotes.length * 5), // word-based estimate
    65536 * 20 // minimum 20 NOCK for multisig
  );

  
  // Validate we have enough funds
  if (totalInputNicks < totalOutputNicks + estimatedFeeNicks) {
    const shortfall = totalOutputNicks + estimatedFeeNicks - totalInputNicks;
    throw new Error(
      `Insufficient funds. Need ~${((totalOutputNicks + estimatedFeeNicks) / 65536).toFixed(4)} NOCK ` +
      `(${(totalOutputNicks / 65536).toFixed(4)} outputs + ~${(estimatedFeeNicks / 65536).toFixed(4)} fee), ` +
      `but only have ${(totalInputNicks / 65536).toFixed(4)} NOCK in selected notes. ` +
      `Short by ~${(shortfall / 65536).toFixed(4)} NOCK.`
    );
  }

  // Verify the multisig spend condition matches the notes' lock root
  const verifySpendCondition = await buildMultisigSpendCondition(threshold, participants);
  const firstNameDigestVerify = verifySpendCondition.firstName();
  const expectedLockRoot = firstNameDigestVerify.value;
  
  // Verify all notes have the expected lock root
  for (let i = 0; i < selectedNotes.length; i++) {
    const noteInfo = selectedNotes[i];
    if (noteInfo.nameFirst && noteInfo.nameFirst !== expectedLockRoot) {
      throw new Error(
        `Spend condition mismatch for note ${i}.`
      );
    }
  }
  
  // Clean up verification spend condition
  try { firstNameDigestVerify.free(); } catch (e) { /* ignore */ }
  try { verifySpendCondition.free(); } catch (e) { /* ignore */ }

  // Keep notes as JavaScript objects with protoNote
  const notesWithProto: NoteWithProto[] = selectedNotes.map((noteInfo) => {
    if (!noteInfo.protoNote) {
      throw new Error('Note missing protoNote - cannot build transaction');
    }
    
    // Extract assets and originPage from protobuf (handle both V1 and legacy formats)
    const noteVersion = noteInfo.protoNote.note_version;
    const noteData = noteVersion?.V1 || noteInfo.protoNote.v1;
    const assetsValue = noteData?.assets?.value || '0';
    const assets = Number(assetsValue);
    const originPageValue = noteData?.origin_page?.value || '0';
    const originPage = Number(originPageValue);
    
    // nameFirst is required for spend condition verification
    const nameFirst = noteInfo.nameFirst;
    if (!nameFirst) {
      throw new Error('Note missing nameFirst (lock root) - cannot determine spend condition');
    }
    
    return {
      protoNote: noteInfo.protoNote,
      assets,
      originPage,
      nameFirst,
      nameLast: undefined, // Not needed for multisig spend
    };
  });

  // Create transaction builder
  const builder = new wasm.TxBuilder(feePerWord);
  if (cleanup) {
    cleanup.register(builder);
  }

  // Get parent hash value for first note BEFORE creating SpendBuilder
  let parentHashValue: string | null = null;
  if (notesWithProto.length > 0 && validSeeds.length > 0) {
    const firstNoteProto = notesWithProto[0].protoNote;
    
    // Create a temporary note just to get the hash
    const tempNote = wasm.Note.fromProtobuf(firstNoteProto);
    try {
      const tempHash = tempNote.hash();
      if (!tempHash) {
        throw new Error('Note.hash() returned null');
      }
      parentHashValue = tempHash.value;
      try { tempHash.free(); } catch (e) { /* ignore */ }
    } catch (err: any) {
      const errorMsg = err?.message || err?.toString() || String(err);
      throw new Error(`Failed to get hash for first note: ${errorMsg}`);
    } finally {
      try { tempNote.free(); } catch (e) { /* ignore */ }
    }
  }

  // Process each selected note
  for (let i = 0; i < notesWithProto.length; i++) {
    const noteInfo = notesWithProto[i];

    // Create FRESH WASM Note from protobuf for SpendBuilder
    const note = wasm.Note.fromProtobuf(noteInfo.protoNote);
    if (cleanup) {
      cleanup.register(note);
    }

    // Create FRESH spend conditions for each SpendBuilder call
    const inputSpendCondition = await buildMultisigSpendCondition(threshold, participants, cleanup);
    const refundSpendCondition = await buildMultisigSpendCondition(threshold, participants, cleanup);
    
    // Get refund spend condition hash BEFORE it gets consumed by SpendBuilder
    const refundSpendConditionHash = refundSpendCondition.hash();
    if (!refundSpendConditionHash) {
      throw new Error('Failed to get refund spend condition hash');
    }
    
    console.log(`[REFUND DEBUG] Note ${i}: Refund spend condition hash: ${refundSpendConditionHash.value}`);

    // Create SpendBuilder - note, inputSpendCondition, and refundSpendCondition are all consumed
    const spendBuilder = new wasm.SpendBuilder(
      note,
      inputSpendCondition,
      refundSpendCondition
    );
    if (cleanup) {
      cleanup.register(spendBuilder);
    }

    // For the first note, add all seeds (outputs)
    if (i === 0 && parentHashValue) {
      for (let seedIdx = 0; seedIdx < validSeeds.length; seedIdx++) {
        const seedData = validSeeds[seedIdx];
        
        const giftNicks = BigInt(Math.floor(seedData.amountNock * 65536));
        const destination = seedData.destination.trim();
        
        let recipientLockRoot: wasm.LockRoot;
        
        if (seedData.destinationType === 'lockroot') {
          // Direct lock root hash - use as-is
          const digest = new wasm.Digest(destination);
          recipientLockRoot = wasm.LockRoot.fromHash(digest);
          if (cleanup) {
            cleanup.register(digest);
          }
        } else {
          // Wallet address (PKH) - derive lock root using firstName()
          // firstName() = hash(true, hash(SpendCondition)) 
          const recipientSpendCondition = await buildSimplePkhSpendCondition(destination, cleanup);
          const firstNameDigest = recipientSpendCondition.firstName();
          
          // Get the value BEFORE passing to fromHash (digest may be consumed)
          const lockRootHash = firstNameDigest.value;
          const lockRootDigest = new wasm.Digest(lockRootHash);
          if (cleanup) {
            cleanup.register(lockRootDigest);
          }
          recipientLockRoot = wasm.LockRoot.fromHash(lockRootDigest);
          
          // Free the original firstName digest since we no longer need it
          try { firstNameDigest.free(); } catch (e) { /* ignore */ }
        }
        
        if (cleanup) {
          cleanup.register(recipientLockRoot);
        }

        // Create FRESH Digest for parentHash - each Seed consumes its parentHash argument
        const parentHashDigest = new wasm.Digest(parentHashValue);
        if (cleanup) {
          cleanup.register(parentHashDigest);
        }

        const noteData = wasm.NoteData.empty();
        if (cleanup) {
          cleanup.register(noteData);
        }

        const seed = new wasm.Seed(
          null, // output_source
          recipientLockRoot,
          giftNicks,
          noteData,
          parentHashDigest // Fresh digest for each seed (WASM object is consumed)
        );
        
        if (cleanup) {
          cleanup.register(seed);
        }
        spendBuilder.seed(seed);
      }
    }

    // Create refund seed manually to ensure consistent hash computation with user seeds
    const noteAssets = Number(noteInfo.assets);
    let spentAssets = 0;
    
    // Only the first note (i === 0) has all the seeds added to it
    if (i === 0) {
      spentAssets = validSeeds.reduce((sum, seed) => sum + Math.floor(seed.amountNock * 65536), 0);
    }
    
    const refundAmount = noteAssets - spentAssets;
    
    if (refundAmount > 0) {
      // Use the pre-captured refund spend condition hash (refundSpendCondition was consumed by SpendBuilder)
      console.log(`[REFUND DEBUG] Note ${i}: Creating refund seed with hash: ${refundSpendConditionHash.value}`);
      console.log(`[REFUND DEBUG] Note ${i}: Refund amount: ${refundAmount}`);
      
      // Create refund LockRoot using fromHash (same as user seeds) for consistent behavior
      const refundHashDigest = new wasm.Digest(refundSpendConditionHash.value);
      const refundLockRoot = wasm.LockRoot.fromHash(refundHashDigest);
      if (cleanup) {
        cleanup.register(refundLockRoot);
        cleanup.register(refundSpendConditionHash);
        cleanup.register(refundHashDigest);
      }
      
      // Create fresh parent hash for refund seed
      if (!parentHashValue) {
        throw new Error('Parent hash value required for refund seed');
      }
      const refundParentHash = new wasm.Digest(parentHashValue);
      if (cleanup) {
        cleanup.register(refundParentHash);
      }
      
      const refundNoteData = wasm.NoteData.empty();
      if (cleanup) {
        cleanup.register(refundNoteData);
      }
      
      const refundSeed = new wasm.Seed(
        null, // output_source
        refundLockRoot,
        BigInt(refundAmount),
        refundNoteData,
        refundParentHash
      );
      
      if (cleanup) {
        cleanup.register(refundSeed);
      }
      
      spendBuilder.seed(refundSeed);
    }

    // Verify spend is balanced before adding to builder (like funding flow does)
    if (!spendBuilder.isBalanced()) {
      throw new Error(`SpendBuilder ${i} is not balanced after adding refund seed`);
    }

    // Add spend to transaction builder
    builder.spend(spendBuilder);
  }

  // Calculate fee (same pattern as funding flow)
  const exactFeeNicks = Number(builder.calcFee());
  
  const availableForFeeAndChange = totalInputNicks - totalOutputNicks;
  
  if (exactFeeNicks > availableForFeeAndChange) {
    const shortfall = exactFeeNicks - availableForFeeAndChange;
    throw new Error(
      `Insufficient funds for transaction fee. ` +
      `The exact fee is ${(exactFeeNicks / 65536).toFixed(4)} NOCK, ` +
      `but only ${(availableForFeeAndChange / 65536).toFixed(4)} NOCK is available after outputs. ` +
      `Either reduce the output amount by ${(shortfall / 65536).toFixed(4)} NOCK, ` +
      `or select more notes as inputs.`
    );
  }
  
  // Set fee and balance refunds (same pattern as funding flow)
  try {
    builder.setFeeAndBalanceRefund(BigInt(exactFeeNicks), true, false);
  } catch (err: any) {
    const errorMsg = err?.message || err?.toString() || String(err);
    // Add more context to the error
    throw new Error(
      `Failed to set transaction fee: ${errorMsg}. ` +
      `Input: ${(totalInputNicks / 65536).toFixed(4)} NOCK, ` +
      `Output: ${(totalOutputNicks / 65536).toFixed(4)} NOCK, ` +
      `Fee: ${(exactFeeNicks / 65536).toFixed(4)} NOCK, ` +
      `Available for fee+change: ${(availableForFeeAndChange / 65536).toFixed(4)} NOCK`
    );
  }
  
  // Get the actual fee after balancing
  const actualFeeNicks = builder.curFee();
  const actualFeeNock = Number(actualFeeNicks) / 65536;

  // Build the unsigned transaction
  let nockchainTx;
  try {
    nockchainTx = builder.build();
  } catch (err: any) {
    const errorMsg = err?.message || err?.toString() || String(err);
    console.error('Error building transaction:', errorMsg);
    throw new Error(
      `Failed to build transaction: ${errorMsg}. ` +
      `This may indicate an issue with the transaction structure or insufficient funds.`
    );
  }
  if (cleanup) {
    cleanup.register(nockchainTx);
  }

  const txId = nockchainTx.id.value;
  
  const rawTx = nockchainTx.toRawTx();
  if (cleanup) {
    cleanup.register(rawTx);
  }

  const rawTxProtobuf = rawTx.toProtobuf();
  
  // Get notes and spend conditions from builder
  const txNotes = builder.allNotes();

  // Convert notes and spend conditions to protobufs
  const notesProtobufs = txNotes.notes.map((n: any) => n.toProtobuf());
  const spendConditionsProtobufs = txNotes.spendConditions.map((sc: any) => sc.toProtobuf());


  return {
    txId,
    rawTxProtobuf,
    notesProtobufs,
    spendConditionsProtobufs,
    actualFeeNicks: Number(actualFeeNicks),
    actualFeeNock,
  };
}

/**
 * Build an unsigned transaction for funding a multisig wallet from a personal wallet.
 * 
 * This function queries the user's personal wallet balance, selects notes,
 * and builds a transaction that sends funds to the multisig lock root.
 * 
 * @param params - Transaction parameters
 * @returns Unsigned transaction ready for signing
 */
export async function buildUnsignedMultisigFundingTx(params: {
  userPkh: string;
  grpcEndpoint: string;
  amountNicks: number;
  multisigSpendCondition: wasm.SpendCondition;
  cleanup?: WasmResourceManager;
}): Promise<UnsignedTransaction> {
  await ensureWasmInitialized();
  
  const {
    userPkh,
    grpcEndpoint,
    amountNicks,
    multisigSpendCondition,
    cleanup,
  } = params;


  // Validate PKH format
  if (!userPkh || typeof userPkh !== 'string') {
    throw new Error(`Invalid PKH: expected string, got ${typeof userPkh}`);
  }
  
  const trimmedPkh = userPkh.trim();

  // Derive both first-names from PKH (simple and coinbase)
  // This matches how the extension queries balances - we need both types
  const userSpendCondition = await buildSimplePkhSpendCondition(trimmedPkh, cleanup);
  
  // Simple first-name (for regular transaction outputs)
  const simpleFirstNameDigest = userSpendCondition.firstName();
  const simpleFirstName = simpleFirstNameDigest.value;
  if (cleanup) {
    cleanup.register(simpleFirstNameDigest);
  }
  
  // Coinbase first-name (for mining rewards)
  const pkhLeaf = wasm.LockPrimitive.newPkh(wasm.Pkh.single(trimmedPkh));
  const timLeaf = wasm.LockPrimitive.newTim(wasm.LockTim.coinbase());
  const coinbaseSpendCondition = new wasm.SpendCondition([pkhLeaf, timLeaf]);
  if (cleanup) {
    cleanup.register(pkhLeaf);
    cleanup.register(timLeaf);
    cleanup.register(coinbaseSpendCondition);
  }
  const coinbaseFirstNameDigest = coinbaseSpendCondition.firstName();
  const coinbaseFirstName = coinbaseFirstNameDigest.value;
  if (cleanup) {
    cleanup.register(coinbaseFirstNameDigest);
  }
  
  // Query both types of notes in parallel 
  const grpcClient = await getGrpcClient(grpcEndpoint);
  let simpleBalance, coinbaseBalance;
  try {
    [simpleBalance, coinbaseBalance] = await Promise.all([
      grpcClient.getBalanceByFirstName(simpleFirstName),
      grpcClient.getBalanceByFirstName(coinbaseFirstName),
    ]);
  } catch (err: any) {
    throw new Error(`Failed to query balance: ${err?.message || err}`);
  }

  // Combine notes from both queries (we only use simple spend condition for all)
  const allNotes = [
    ...(simpleBalance?.notes || []),
    ...(coinbaseBalance?.notes || [])
  ];

  if (allNotes.length === 0) {
    throw new Error('No notes found in your wallet. Please fund your personal wallet first.');
  }
  
  // Keep notes as JavaScript objects with protoNote 
  const notesWithProto: NoteWithProto[] = allNotes.map((entry: any) => {
    if (!entry.note) {
      throw new Error('Balance entry missing note protobuf');
    }
    
    // Extract assets and originPage from protobuf (handle both V1 and legacy formats)
    const noteVersion = entry.note.note_version;
    const noteData = noteVersion?.V1 || entry.note.v1;
    const assetsValue = noteData?.assets?.value || '0';
    const assets = Number(assetsValue);
    const originPageValue = noteData?.origin_page?.value || '0';
    const originPage = Number(originPageValue);
    
    // nameFirst is required for spend condition discovery
    const nameFirst = entry.name?.first;
    if (!nameFirst) {
      throw new Error('Balance entry missing name.first (lock root) - cannot determine spend condition');
    }
    
    return {
      protoNote: entry.note,
      assets,
      originPage,
      nameFirst,
      nameLast: entry.name?.last,
    };
  });
  
  // Calculate total available from JavaScript objects 
  const totalAvailable = notesWithProto.reduce((sum, n) => sum + n.assets, 0);
  
  // Check if we have enough balance at all (just for amount, fee will be calculated exactly later)
  if (totalAvailable < amountNicks) {
    throw new Error(
      `Insufficient balance. Need at least ${(amountNicks / 65536).toFixed(2)} NOCK, ` +
      `but only have ${(totalAvailable / 65536).toFixed(2)} NOCK available.`
    );
  }
  
  // Select notes needed to cover amount + conservative fee estimate
  const conservativeFeeEstimateNicks = Math.max(
    Math.ceil(amountNicks * 0.2), // 20% of amount
    65536 // Minimum 1 NOCK fee estimate
  );
  const targetWithFee = amountNicks + conservativeFeeEstimateNicks;
  
  // Uses greedy algorithm: largest notes first until we have enough
  let selectedNotes = selectNotesForAmount(notesWithProto, targetWithFee);
  if (!selectedNotes) {
    // Fallback: if conservative estimate fails, try selecting based on amount only
    if (totalAvailable >= amountNicks) {
      // Select notes based on amount only, we'll verify exact fee after building
      selectedNotes = selectNotesForAmount(notesWithProto, amountNicks);
      if (!selectedNotes) {
        throw new Error('Failed to select sufficient notes for transaction');
      }
    } else {
      throw new Error('Failed to select sufficient notes for transaction');
    }
  }

  // Build transaction using SpendBuilder
  const feePerWord = BigInt(32768); // 0.5 NOCK per word
  const builder = new wasm.TxBuilder(feePerWord);
  if (cleanup) {
    cleanup.register(builder);
  }

  // Create lock root from multisig spend condition for the output
  const multisigLockRoot = wasm.LockRoot.fromSpendCondition(multisigSpendCondition);
  if (cleanup) {
    cleanup.register(multisigLockRoot);
  }

  const giftAmount = BigInt(amountNicks);

  // Get parent hash value for first note BEFORE creating SpendBuilder
  let parentHashValue: string | null = null;
  if (selectedNotes.length > 0 && giftAmount > 0n) {
    const firstNoteProto = selectedNotes[0].protoNote;
    
    // Create a temporary note just to get the hash
    const tempNote = wasm.Note.fromProtobuf(firstNoteProto);
    try {
      const tempHash = tempNote.hash();
      if (!tempHash) {
        throw new Error('Note.hash() returned null');
      }
      parentHashValue = tempHash.value;
      try { tempHash.free(); } catch (e) { /* ignore */ }
    } catch (err: any) {
      const errorMsg = err?.message || err?.toString() || String(err);
      throw new Error(`Failed to get hash for first note: ${errorMsg}`);
    } finally {
      try { tempNote.free(); } catch (e) { /* ignore */ }
    }
  }
  
  // Process each selected note
  for (let i = 0; i < selectedNotes.length; i++) {
    const noteInfo = selectedNotes[i];
    
    // Create FRESH WASM Note from protobuf for SpendBuilder
    const note = wasm.Note.fromProtobuf(noteInfo.protoNote);
    if (cleanup) {
      cleanup.register(note);
    }
    
    // Discover the correct spend condition for this note by matching its nameFirst (lock root)
    const inputSpendCondition = await discoverSpendConditionForNote(
      trimmedPkh,
      { nameFirst: noteInfo.nameFirst, originPage: noteInfo.originPage },
      cleanup
    );
    
    // Refund goes back to user with simple PKH
    const refundSpendCondition = await buildSimplePkhSpendCondition(trimmedPkh, cleanup);
    
    // Create SpendBuilder with discovered spend condition for input
    const spendBuilder = new wasm.SpendBuilder(
      note,
      inputSpendCondition,
      refundSpendCondition
    );
    if (cleanup) {
      cleanup.register(spendBuilder);
    }

    // Add seed for multisig output (only on first spend to avoid duplicates)
    if (i === 0 && giftAmount > 0n && parentHashValue) {
      // Create FRESH Digest for parentHash - Seed consumes its parentHash argument
      const parentHashDigest = new wasm.Digest(parentHashValue);
      if (cleanup) {
        cleanup.register(parentHashDigest);
      }
      
      const noteData = wasm.NoteData.empty();
      if (cleanup) {
        cleanup.register(noteData);
      }
      
      const multisigSeed = new wasm.Seed(
        null, // output_source
        multisigLockRoot, // lock_root - this creates the note with multisig spend condition
        giftAmount, // gift amount
        noteData, // note_data
        parentHashDigest // parent_hash (fresh digest for each seed)
      );
      if (cleanup) {
        cleanup.register(multisigSeed);
      }
      spendBuilder.seed(multisigSeed);
    }

    // Compute refund to balance the spend (creates refund seed using refund_lock)
    spendBuilder.computeRefund(false);
    
    // Verify spend is balanced before adding to builder
    if (!spendBuilder.isBalanced()) {
      throw new Error(`SpendBuilder ${i} is not balanced after computeRefund`);
    }
    
    // Add spend to builder
    builder.spend(spendBuilder);
  }

  // Calculate exact fee (deterministic: fee = word_count × 32,768 nicks)
  const exactFeeNicks = Number(builder.calcFee());
  const totalNeeded = amountNicks + exactFeeNicks;
  const totalSelected = selectedNotes.reduce((sum: number, n) => sum + n.assets, 0);
  
  // Verify we have enough funds with the exact fee
  // If insufficient, we need more notes (but that would require rebuilding, so we fail here)
  if (totalSelected < totalNeeded) {
    const totalAvailable = notesWithProto.reduce((sum: number, n) => sum + n.assets, 0);
    if (totalAvailable >= totalNeeded) {
      // We have enough total, but didn't select enough notes
      throw new Error(
        `Insufficient funds in selected notes. Need ${(totalNeeded / 65536).toFixed(4)} NOCK ` +
        `(${(amountNicks / 65536).toFixed(4)} amount + ${(exactFeeNicks / 65536).toFixed(4)} exact fee), ` +
        `but only selected ${(totalSelected / 65536).toFixed(4)} NOCK. ` +
        `You have ${(totalAvailable / 65536).toFixed(4)} NOCK total available. ` +
        `Please try again - the system will select more notes automatically.`
      );
    } else {
      // Don't have enough total balance
      throw new Error(
        `Insufficient balance. Need ${(totalNeeded / 65536).toFixed(4)} NOCK ` +
        `(${(amountNicks / 65536).toFixed(4)} amount + ${(exactFeeNicks / 65536).toFixed(4)} exact fee), ` +
        `but only have ${(totalAvailable / 65536).toFixed(4)} NOCK available.`
      );
    }
  }

  // Set fee and balance refunds
  // adjust_fee=true allows slight adjustments if transaction structure changes
  try {
    builder.setFeeAndBalanceRefund(BigInt(exactFeeNicks), true, false);
  } catch (err: any) {
    const errorMsg = err?.message || err?.toString() || String(err);
    throw new Error(`Failed to set transaction fee: ${errorMsg}`);
  }

  // Build the unsigned transaction
  let nockchainTx;
  try {
    nockchainTx = builder.build();
  } catch (err: any) {
    const errorMsg = err?.message || err?.toString() || String(err);
    console.error('Error building transaction:', errorMsg);
    throw new Error(
      `Failed to build transaction: ${errorMsg}. ` +
      `This may indicate an issue with the transaction structure or insufficient funds.`
    );
  }
  if (cleanup) {
    cleanup.register(nockchainTx);
  }

  const txId = nockchainTx.id.value;
  
  const rawTx = nockchainTx.toRawTx();
  if (cleanup) {
    cleanup.register(rawTx);
  }

  const rawTxProtobuf = rawTx.toProtobuf();
  
  // Get notes and spend conditions from builder
  const txNotes = builder.allNotes();

  // Convert notes and spend conditions to protobufs
  const notesProtobufs = txNotes.notes.map((n: any) => n.toProtobuf());
  const spendConditionsProtobufs = txNotes.spendConditions.map((sc: any) => sc.toProtobuf());

  // Get the actual fee after balancing
  const actualFeeNicks = builder.curFee();
  const actualFeeNock = Number(actualFeeNicks) / 65536;

  return {
    txId,
    rawTxProtobuf,
    notesProtobufs,
    spendConditionsProtobufs,
    actualFeeNicks: Number(actualFeeNicks),
    actualFeeNock,
  };
}

/**
 * Validate a signed transaction before broadcasting.
 * 
 * This reconstructs a TxBuilder from the transaction and runs validation to check:
 * 1. Fee is sufficient (cur_fee >= calc_fee)
 * 2. All spends are balanced (note.assets = seeds + fee)
 * 3. No missing unlocks (all required signatures are present)
 * 
 * @param params - Transaction data from signing
 * @returns Validation result with success status, actual transaction ID, and any error message
 */
export async function validateSignedTransaction(params: {
  signedTxProtobuf: object;
  notesProtobufs: object[];
  spendConditionsProtobufs: object[];
  cleanup?: WasmResourceManager;
}): Promise<{ valid: boolean; signedTxId?: string; error?: string }> {
  await ensureWasmInitialized();
  
  const { signedTxProtobuf, notesProtobufs, spendConditionsProtobufs, cleanup } = params;

  try {
    // Reconstruct WASM objects from protobufs
    const rawTx = wasm.RawTx.fromProtobuf(signedTxProtobuf);
    if (cleanup) cleanup.register(rawTx);

    // Note: rawTx.id.value might be stale after signature merging, so we recalculate below

    const notes = notesProtobufs.map((proto) => {
      const note = wasm.Note.fromProtobuf(proto);
      if (cleanup) cleanup.register(note);
      return note;
    });

    const spendConditions = spendConditionsProtobufs.map((proto) => {
      const sc = wasm.SpendCondition.fromProtobuf(proto);
      if (cleanup) cleanup.register(sc);
      return sc;
    });

    // Verify that spend conditions match notes
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const sc = spendConditions[i];
      const noteNameFirst = note.name.first;
      const scFirstName = sc.firstName().value;
      
      if (noteNameFirst !== scFirstName) {
        throw new Error(`Spend condition mismatch for note ${i}`);
      }
    }

    // Reconstruct TxBuilder from the signed transaction
    const builder = wasm.TxBuilder.fromTx(rawTx, notes, spendConditions);
    if (cleanup) cleanup.register(builder);

    // Validate the transaction
    builder.validate();

    // Recalculate the transaction ID to ensure it's correct
    const correctTxId = rawTx.recalcId().value;

    return { valid: true, signedTxId: correctTxId };
  } catch (err: any) {
    const errorMsg = err?.message || err?.toString() || String(err);
    console.error('=== Transaction Validation: FAILED ===');
    console.error('Error:', errorMsg);
    return { valid: false, error: errorMsg };
  }
}
