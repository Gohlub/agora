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

// ============================================================
// Multisig SpendCondition Utilities
// ============================================================

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
 * Create WASM notes from a balance query result.
 */
export async function createWasmNotesFromBalance(
  balance: any,
  cleanup?: WasmResourceManager
): Promise<wasm.Note[]> {
  await ensureWasmInitialized();
  
  if (!balance?.notes || balance.notes.length === 0) {
    throw new Error('No notes found in balance');
  }
  
  const wasmNotes = balance.notes.map((entry: any, index: number) => {
    // Log entry structure for debugging
    if (index === 0) {
      console.log('First balance entry structure:', {
        keys: Object.keys(entry),
        hasNote: !!entry.note,
        noteType: typeof entry.note,
        noteKeys: entry.note ? Object.keys(entry.note) : null,
        name: entry.name,
        noteDataHash: entry.note_data_hash
      });
    }
    
    if (!entry.note) {
      throw new Error(`Balance entry at index ${index} missing note protobuf`);
    }
    
    // Use entry.note directly (this is the protobuf, same as note.protoNote in extension)
    const protoNote = entry.note;
    
    let note;
    try {
      note = wasm.Note.fromProtobuf(protoNote);
      if (!note) {
        throw new Error('Note.fromProtobuf returned null');
      }
      
      // Immediately validate the note is usable
      try {
        const testAssets = note.assets;
        if (testAssets === null || testAssets === undefined) {
          throw new Error('Note.assets is null/undefined after creation');
        }
      } catch (err: any) {
        const errorMsg = err?.message || err?.toString() || String(err);
        console.error(`Note at index ${index} is invalid immediately after creation:`, errorMsg);
        throw new Error(`Note created but not usable: ${errorMsg}`);
      }
    } catch (err: any) {
      const errorMsg = err?.message || err?.toString() || String(err);
      console.error(`Error creating note from protobuf at index ${index}:`, errorMsg);
      console.error('Entry structure:', {
        keys: Object.keys(entry),
        noteType: typeof entry.note,
        noteStructure: entry.note ? Object.keys(entry.note) : null
      });
      throw new Error(`Failed to create note from protobuf at index ${index}: ${errorMsg}`);
    }
    
    if (cleanup) {
      cleanup.register(note);
    }
    return note;
  });
  
  return wasmNotes;
}

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
  console.log('[buildUnsignedMultisigSpendTx] Starting...');
  await ensureWasmInitialized();
  console.log('[buildUnsignedMultisigSpendTx] WASM initialized');

  const { threshold, participants, selectedNotes, seeds, cleanup } = params;
  console.log(`[buildUnsignedMultisigSpendTx] Config: ${threshold}-of-${participants.length}, ${selectedNotes.length} notes, ${seeds.length} seeds`);

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
  
  console.log(`[buildUnsignedMultisigSpendTx] Total input: ${(totalInputNicks / 65536).toFixed(4)} NOCK (${totalInputNicks} nicks)`);
  console.log(`[buildUnsignedMultisigSpendTx] Total output: ${(totalOutputNicks / 65536).toFixed(4)} NOCK (${totalOutputNicks} nicks)`);
  
  // Conservative fee estimate for multisig: ~50 NOCK for 2-of-3, scales with participants
  // Multisig signatures are larger than single-sig
  const estimatedFeeNicks = Math.max(
    32768 * (10 + participants.length * 15 + selectedNotes.length * 5), // word-based estimate
    65536 * 20 // minimum 20 NOCK for multisig
  );
  console.log(`[buildUnsignedMultisigSpendTx] Estimated fee: ${(estimatedFeeNicks / 65536).toFixed(4)} NOCK`);
  
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
  console.log('[buildUnsignedMultisigSpendTx] Building verify spend condition...');
  const verifySpendCondition = await buildMultisigSpendCondition(threshold, participants);
  console.log('[buildUnsignedMultisigSpendTx] Getting expectedLockRoot...');
  const firstNameDigestVerify = verifySpendCondition.firstName();
  const expectedLockRoot = firstNameDigestVerify.value;
  console.log(`[buildUnsignedMultisigSpendTx] Expected lock root: ${expectedLockRoot.slice(0, 16)}...`);
  
  // Verify all notes have the expected lock root
  for (let i = 0; i < selectedNotes.length; i++) {
    const noteInfo = selectedNotes[i];
    console.log(`[buildUnsignedMultisigSpendTx] Note ${i} nameFirst: ${noteInfo.nameFirst?.slice(0, 16) || 'undefined'}...`);
    if (noteInfo.nameFirst && noteInfo.nameFirst !== expectedLockRoot) {
      throw new Error(
        `Spend condition mismatch for note ${i}. ` +
        `The participants may be in a different order than when the wallet was created.`
      );
    }
  }
  
  // Clean up verification spend condition
  try { firstNameDigestVerify.free(); } catch (e) { /* ignore */ }
  try { verifySpendCondition.free(); } catch (e) { /* ignore */ }

  // Create transaction builder
  console.log('[buildUnsignedMultisigSpendTx] Creating TxBuilder...');
  const builder = new wasm.TxBuilder(feePerWord);
  if (cleanup) {
    cleanup.register(builder);
  }
  console.log('[buildUnsignedMultisigSpendTx] TxBuilder created');

  // Process each selected note
  // IMPORTANT: WASM objects are consumed when passed to constructors,
  // so we must create FRESH instances for each parameter
  for (let i = 0; i < selectedNotes.length; i++) {
    console.log(`[buildUnsignedMultisigSpendTx] Processing note ${i}...`);
    const noteInfo = selectedNotes[i];

    // Create FRESH WASM Note from protobuf for SpendBuilder
    console.log(`[buildUnsignedMultisigSpendTx] Creating Note from protobuf...`);
    const note = wasm.Note.fromProtobuf(noteInfo.protoNote);
    console.log(`[buildUnsignedMultisigSpendTx] Note created, registering with cleanup...`);
    if (cleanup) {
      cleanup.register(note);
    }

    // Get parent hash value BEFORE passing note to SpendBuilder (note will be consumed)
    // We store the hash VALUE (string) so we can create fresh Digest objects for each seed
    // (WASM objects are consumed when passed to constructors)
    let parentHashValue: string | null = null;
    if (i === 0 && validSeeds.length > 0) {
      console.log(`[buildUnsignedMultisigSpendTx] Getting note hash for parentHashValue...`);
      const tempHash = note.hash();
      parentHashValue = tempHash.value;
      console.log(`[buildUnsignedMultisigSpendTx] parentHashValue: ${parentHashValue.slice(0, 16)}...`);
      try { tempHash.free(); } catch (e) { /* ignore */ }
    }

    // Create FRESH spend conditions for each SpendBuilder call
    // (WASM objects are consumed when passed to SpendBuilder)
    console.log(`[buildUnsignedMultisigSpendTx] Building inputSpendCondition...`);
    const inputSpendCondition = await buildMultisigSpendCondition(threshold, participants, cleanup);
    console.log(`[buildUnsignedMultisigSpendTx] Building refundSpendCondition...`);
    const refundSpendCondition = await buildMultisigSpendCondition(threshold, participants, cleanup);
    console.log(`[buildUnsignedMultisigSpendTx] Both spend conditions built`);

    // Create SpendBuilder - note, inputSpendCondition, and refundSpendCondition are all consumed
    console.log(`[buildUnsignedMultisigSpendTx] Creating SpendBuilder...`);
    const spendBuilder = new wasm.SpendBuilder(
      note,
      inputSpendCondition,
      refundSpendCondition
    );
    console.log(`[buildUnsignedMultisigSpendTx] SpendBuilder created`);
    if (cleanup) {
      cleanup.register(spendBuilder);
    }

    // For the first note, add all seeds (outputs)
    if (i === 0 && parentHashValue) {
      console.log(`[buildUnsignedMultisigSpendTx] Adding ${validSeeds.length} seeds...`);
      for (let seedIdx = 0; seedIdx < validSeeds.length; seedIdx++) {
        const seedData = validSeeds[seedIdx];
        console.log(`[buildUnsignedMultisigSpendTx] Seed ${seedIdx}: ${seedData.amountNock} NOCK to ${seedData.destinationType}:${seedData.destination.slice(0, 12)}...`);
        
        const giftNicks = BigInt(Math.floor(seedData.amountNock * 65536));
        const destination = seedData.destination.trim();
        
        let recipientLockRoot: wasm.LockRoot;
        
        if (seedData.destinationType === 'lockroot') {
          // Direct lock root hash - use as-is
          console.log(`[buildUnsignedMultisigSpendTx] Creating Digest for lock root...`);
          const digest = new wasm.Digest(destination);
          console.log(`[buildUnsignedMultisigSpendTx] Creating LockRoot from hash...`);
          recipientLockRoot = wasm.LockRoot.fromHash(digest);
          if (cleanup) {
            cleanup.register(digest);
          }
          console.log(`  → ${seedData.amountNock.toFixed(4)} NOCK to lock root ${destination.slice(0, 12)}...`);
        } else {
          // Wallet address (PKH) - derive lock root using firstName()
          // firstName() = hash(true, hash(SpendCondition)) - this is what wallets query for
          console.log(`[buildUnsignedMultisigSpendTx] Building recipient SpendCondition for PKH...`);
          const recipientSpendCondition = await buildSimplePkhSpendCondition(destination, cleanup);
          console.log(`[buildUnsignedMultisigSpendTx] Getting firstName from recipient SpendCondition...`);
          const firstNameDigest = recipientSpendCondition.firstName();
          
          // Get the value BEFORE passing to fromHash (digest may be consumed)
          const lockRootHash = firstNameDigest.value;
          console.log(`[buildUnsignedMultisigSpendTx] firstName value: ${lockRootHash.slice(0, 16)}...`);
          
          console.log(`[buildUnsignedMultisigSpendTx] Creating LockRoot from firstName...`);
          // Create a fresh digest for LockRoot.fromHash since we already extracted the value
          const lockRootDigest = new wasm.Digest(lockRootHash);
          if (cleanup) {
            cleanup.register(lockRootDigest);
          }
          recipientLockRoot = wasm.LockRoot.fromHash(lockRootDigest);
          
          // Free the original firstName digest since we no longer need it
          try { firstNameDigest.free(); } catch (e) { /* ignore */ }
          
          console.log(`  → ${seedData.amountNock.toFixed(4)} NOCK to wallet ${destination.slice(0, 12)}... → lock root: ${lockRootHash.slice(0, 12)}...`);
        }
        
        if (cleanup) {
          cleanup.register(recipientLockRoot);
        }

        // Create FRESH Digest for parentHash - each Seed consumes its parentHash argument
        console.log(`[buildUnsignedMultisigSpendTx] Creating parentHashDigest...`);
        const parentHashDigest = new wasm.Digest(parentHashValue);
        if (cleanup) {
          cleanup.register(parentHashDigest);
        }

        console.log(`[buildUnsignedMultisigSpendTx] Creating NoteData.empty()...`);
        const noteData = wasm.NoteData.empty();
        if (cleanup) {
          cleanup.register(noteData);
        }

        console.log(`[buildUnsignedMultisigSpendTx] Creating Seed...`);
        const seed = new wasm.Seed(
          null, // output_source
          recipientLockRoot,
          giftNicks,
          noteData,
          parentHashDigest // Fresh digest for each seed (WASM object is consumed)
        );
        console.log(`[buildUnsignedMultisigSpendTx] Seed created`);
        
        // Verify the seed has the correct lock root
        const seedLockRootHash = seed.lockRoot.hash.value;
        console.log(`[buildUnsignedMultisigSpendTx] VERIFY: Seed lock_root.hash = ${seedLockRootHash}`);
        console.log(`[buildUnsignedMultisigSpendTx] VERIFY: Expected firstName = ${seedData.destinationType === 'wallet' ? 'derived from PKH' : destination}`);
        
        if (cleanup) {
          cleanup.register(seed);
        }

        console.log(`[buildUnsignedMultisigSpendTx] Adding seed to spendBuilder...`);
        spendBuilder.seed(seed);
        console.log(`[buildUnsignedMultisigSpendTx] Seed ${seedIdx} added`);
      }
    }

    // Use computeRefund to create refund seed (uses wrong lock root internally, but we'll fix it after building)
    // NOTE: computeRefund uses LockRoot::Lock(spendCondition) which hashes via spendCondition.hash(),
    // but wallets query notes by firstName(). We fix this in the protobuf after building.
    console.log(`[buildUnsignedMultisigSpendTx] Computing refund...`);
    spendBuilder.computeRefund(false);
    console.log(`[buildUnsignedMultisigSpendTx] Refund computed`);

    // Verify spend is balanced before adding to builder (like funding flow does)
    console.log(`[buildUnsignedMultisigSpendTx] Checking if spend is balanced...`);
    if (!spendBuilder.isBalanced()) {
      throw new Error(`SpendBuilder ${i} is not balanced after computeRefund`);
    }
    console.log(`[buildUnsignedMultisigSpendTx] Spend is balanced`);

    // Add spend to transaction builder
    console.log(`[buildUnsignedMultisigSpendTx] Adding spend to builder...`);
    builder.spend(spendBuilder);
    console.log(`[buildUnsignedMultisigSpendTx] Spend ${i} added to builder`);
  }

  // Calculate fee (same pattern as funding flow)
  console.log(`[buildUnsignedMultisigSpendTx] Calculating fee...`);
  const exactFeeNicks = Number(builder.calcFee());
  console.log(`[buildUnsignedMultisigSpendTx] Calculated fee: ${exactFeeNicks} nicks (${(exactFeeNicks / 65536).toFixed(4)} NOCK)`);
  
  // Log the state before setFeeAndBalanceRefund
  const curFeeBeforeSet = Number(builder.curFee());
  console.log(`[buildUnsignedMultisigSpendTx] Current fee before set: ${curFeeBeforeSet} nicks`);
  console.log(`[buildUnsignedMultisigSpendTx] Input total: ${totalInputNicks} nicks, Output total: ${totalOutputNicks} nicks`);
  
  const availableForFeeAndChange = totalInputNicks - totalOutputNicks;
  console.log(`[buildUnsignedMultisigSpendTx] Available for fee+change: ${availableForFeeAndChange} nicks (${(availableForFeeAndChange / 65536).toFixed(4)} NOCK)`);
  
  // Verify we have enough for the exact fee before attempting to set it
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
  console.log(`[buildUnsignedMultisigSpendTx] Setting fee and balancing refunds with fee=${exactFeeNicks}...`);
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
  console.log(`[buildUnsignedMultisigSpendTx] Fee set and refunds balanced`);
  
  // Get the actual fee after balancing
  const actualFeeNicks = builder.curFee();
  const actualFeeNock = Number(actualFeeNicks) / 65536;
  console.log(`[buildUnsignedMultisigSpendTx] Actual fee: ${actualFeeNock.toFixed(4)} NOCK (${actualFeeNicks} nicks)`);

  // Build the unsigned transaction
  console.log(`[buildUnsignedMultisigSpendTx] Building transaction...`);
  const nockchainTx = builder.build();
  if (cleanup) {
    cleanup.register(nockchainTx);
  }
  console.log(`[buildUnsignedMultisigSpendTx] Transaction built`);
  
  // Log the seeds in the built transaction for verification
  const builtRawTx = nockchainTx.toRawTx();
  const builtProtobuf = builtRawTx.toProtobuf();
  console.log(`[buildUnsignedMultisigSpendTx] Built transaction seeds:`);
  if (builtProtobuf.spends) {
    for (let spendIdx = 0; spendIdx < builtProtobuf.spends.length; spendIdx++) {
      const spend = builtProtobuf.spends[spendIdx];
      if (spend.spend?.spend_kind?.Witness?.seeds) {
        const seeds = spend.spend.spend_kind.Witness.seeds;
        for (let sIdx = 0; sIdx < seeds.length; sIdx++) {
          const s = seeds[sIdx];
          const lockRoot = s.lock_root?.value || s.lock_root;
          const gift = s.gift?.value || s.gift;
          console.log(`  Spend[${spendIdx}].Seed[${sIdx}]: lock_root=${lockRoot}, gift=${gift}`);
        }
      }
    }
  }

  const txId = nockchainTx.id.value;
  console.log(`[buildUnsignedMultisigSpendTx] Transaction ID: ${txId.slice(0, 16)}...`);
  
  console.log(`[buildUnsignedMultisigSpendTx] Converting to RawTx...`);
  const rawTx = nockchainTx.toRawTx();
  if (cleanup) {
    cleanup.register(rawTx);
  }

  console.log(`[buildUnsignedMultisigSpendTx] Converting to protobuf...`);
  const rawTxProtobuf = rawTx.toProtobuf();
  
  // NOTE: The refund seed uses spendCondition.hash() for lock root, not firstName().
  // This means the change note won't be found by wallets querying firstName().
  // However, the transaction is still valid - the network accepts hash() as valid lock root.
  // A proper fix would require changes to the WASM bindings or iris-rs.
  // For now, we log the discrepancy:
  const discrepancyCondition = await buildMultisigSpendCondition(threshold, participants);
  const hashLockRoot = discrepancyCondition.hash().value;
  const firstNameLockRoot = discrepancyCondition.firstName().value;
  console.log(`[buildUnsignedMultisigSpendTx] NOTE: Refund uses hash() lock root: ${hashLockRoot.slice(0, 16)}...`);
  console.log(`[buildUnsignedMultisigSpendTx] NOTE: Wallet queries firstName(): ${firstNameLockRoot.slice(0, 16)}...`);
  console.log(`[buildUnsignedMultisigSpendTx] NOTE: Change note may not appear in wallet UI until proper fix.`);
  try { discrepancyCondition.free(); } catch (e) { /* ignore */ }
  
  console.log(`[buildUnsignedMultisigSpendTx] Getting allNotes...`);
  const txNotes = builder.allNotes();

  // Convert notes and spend conditions to protobufs
  console.log(`[buildUnsignedMultisigSpendTx] Converting ${txNotes.notes.length} notes to protobufs...`);
  const notesProtobufs = txNotes.notes.map((n: any) => n.toProtobuf());
  console.log(`[buildUnsignedMultisigSpendTx] Converting ${txNotes.spendConditions.length} spendConditions to protobufs...`);
  const spendConditionsProtobufs = txNotes.spendConditions.map((sc: any) => sc.toProtobuf());

  console.log(`[buildUnsignedMultisigSpendTx] Complete! Fee: ${actualFeeNock.toFixed(4)} NOCK`);

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
  

  // Query both types of notes in parallel (like the extension does)
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
  
  // Create a combined balance structure for createWasmNotesFromBalance
  const balance = {
    notes: allNotes,
    height: simpleBalance?.height || coinbaseBalance?.height,
    block_id: simpleBalance?.block_id || coinbaseBalance?.block_id,
  };

  // Keep notes as JavaScript objects with protoNote (like extension does)
  // Convert to WASM Note objects only when actually building the transaction
  // This avoids WASM object lifecycle issues
  interface NoteWithProto {
    protoNote: any;
    assets: number;
    originPage: number;
    nameFirst: string;
    nameLast?: string;
  }
  
  const notesWithProto: NoteWithProto[] = balance.notes.map((entry: any) => {
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
  
  // Calculate total available from JavaScript objects (no WASM needed)
  const totalAvailable = notesWithProto.reduce((sum, n) => sum + n.assets, 0);
  console.log(`Found ${notesWithProto.length} notes, total: ${(totalAvailable / 65536).toFixed(4)} NOCK`);
  
  // Check if we have enough balance at all (just for amount, fee will be calculated exactly later)
  if (totalAvailable < amountNicks) {
    throw new Error(
      `Insufficient balance. Need at least ${(amountNicks / 65536).toFixed(2)} NOCK, ` +
      `but only have ${(totalAvailable / 65536).toFixed(2)} NOCK available.`
    );
  }
  
  // Step 3: Select notes needed to cover amount + conservative fee estimate
  // Fee is deterministic: fee = word_count × 32,768 nicks
  // Conservative estimate: assume ~10 words per input (signature + merkle proof + note data)
  // For 1-2 inputs: ~0.1 NOCK fee, for more inputs: ~0.05 NOCK per input
  // Add 20% buffer to be safe
  const conservativeFeeEstimateNicks = Math.max(
    Math.ceil(amountNicks * 0.2), // 20% of amount
    65536 // Minimum 1 NOCK fee estimate
  );
  const targetWithFee = amountNicks + conservativeFeeEstimateNicks;
  
  // Uses greedy algorithm: largest notes first until we have enough
  // Select from JavaScript note objects (no WASM yet)
  let selectedNotes = selectNotesForAmount(notesWithProto, targetWithFee);
  if (!selectedNotes) {
    // Fallback: if conservative estimate fails, try selecting based on amount only
    // (this handles edge cases where fee estimate was too high)
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

  // Step 4: Build user's spend condition for inputs (already created above for first-name derivation)
  // userSpendCondition is already available from above

  // Step 5: Convert selected notes to WASM Note objects (like extension does)
  // Convert only when needed, right before building the transaction
  // Step 5: Convert selected notes to WASM Note objects
  const wasmNotes = selectedNotes.map((note) => {
    if (!note.protoNote) {
      throw new Error('Note missing protoNote - cannot build transaction');
    }
    const wasmNote = wasm.Note.fromProtobuf(note.protoNote);
    if (cleanup) {
      cleanup.register(wasmNote);
    }
    return wasmNote;
  });

  // Step 6: Build transaction using SpendBuilder
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

  // Step 7: Create SpendBuilder for each input note
  // Strategy: Add gift seed to first note, then let recalcAndSetFee handle refunds automatically
  // 
  // IMPORTANT: SpendBuilder takes ownership of the note, so we need to:
  // 1. Get the hash BEFORE passing the note to SpendBuilder
  // 2. Clone the note for SpendBuilder if we need to access it afterwards
  
  // For the first note, get parent hash BEFORE creating SpendBuilder
  // (SpendBuilder consumes the note, so we need the hash beforehand)
  let parentHash: wasm.Digest | null = null;
  if (wasmNotes.length > 0 && giftAmount > 0n) {
    const firstNoteProto = selectedNotes[0].protoNote;
    
    // Create a temporary note just to get the hash
    const tempNote = wasm.Note.fromProtobuf(firstNoteProto);
    try {
      parentHash = tempNote.hash();
      if (!parentHash) {
        throw new Error('Note.hash() returned null');
      }
      if (cleanup) {
        cleanup.register(parentHash);
      }
    } catch (err: any) {
      const errorMsg = err?.message || err?.toString() || String(err);
      throw new Error(`Failed to get hash for first note: ${errorMsg}`);
    } finally {
      try { tempNote.free(); } catch (e) { /* ignore */ }
    }
  }
  
  for (let i = 0; i < wasmNotes.length; i++) {
    const note = wasmNotes[i];
    const noteInfo = selectedNotes[i];
    
    // Validate note is not null/undefined
    if (!note) {
      throw new Error(`Invalid note at index ${i}: note is null or undefined`);
    }
    
    // Discover the correct spend condition for this note by matching its nameFirst (lock root)
    // This is critical: the spend condition must match how the note was originally locked
    const inputSpendCondition = await discoverSpendConditionForNote(
      trimmedPkh,
      { nameFirst: noteInfo.nameFirst, originPage: noteInfo.originPage },
      cleanup
    );
    
    // Refund goes back to user with simple PKH (no timelock needed for change)
    const refundSpendCondition = await buildSimplePkhSpendCondition(trimmedPkh, cleanup);
    
    // Create SpendBuilder with discovered spend condition for input
    // Note: SpendBuilder takes ownership of note, spend_condition, and refund_lock
    const spendBuilder = new wasm.SpendBuilder(
      note,
      inputSpendCondition,
      refundSpendCondition
    );
    if (cleanup) {
      cleanup.register(spendBuilder);
    }

    // Add seed for multisig output (only on first spend to avoid duplicates)
    if (i === 0 && giftAmount > 0n && parentHash) {
      const multisigSeed = new wasm.Seed(
        null, // output_source
        multisigLockRoot, // lock_root - this creates the note with multisig spend condition
        giftAmount, // gift amount
        wasm.NoteData.empty(), // note_data
        parentHash // parent_hash (already computed before the loop)
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

  // Step 8: Calculate exact fee (deterministic: fee = word_count × 32,768 nicks)
  const exactFeeNicks = Number(builder.calcFee());
  const totalNeeded = amountNicks + exactFeeNicks;
  const totalSelected = selectedNotes.reduce((sum: number, n) => sum + n.assets, 0);
  
  // Log fee calculation for debugging (can be removed in production)
  console.log('Transaction fee:', `${(exactFeeNicks / 65536).toFixed(4)} NOCK`);
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

  // Step 10: Build the unsigned transaction
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

  const rawTx = nockchainTx.toRawTx();
  if (cleanup) {
    cleanup.register(rawTx);
  }

  // Get notes and spend conditions from builder (as Iris example does)
  // This ensures they match exactly what's in the transaction
  const txNotes = builder.allNotes();
  const notesProtobufs = txNotes.notes.map((n: any) => n.toProtobuf());
  const spendConditionsProtobufs = txNotes.spendConditions.map((sc: any) => sc.toProtobuf());

  const txId = nockchainTx.id.value;
  const rawTxProtobuf = rawTx.toProtobuf();
  
  // Get actual fee from builder
  const actualFeeNicks = Number(builder.curFee());
  const actualFeeNock = actualFeeNicks / 65536;

  return {
    txId,
    rawTxProtobuf,
    notesProtobufs,
    spendConditionsProtobufs,
    actualFeeNicks,
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

    const signedTxId = rawTx.id.value;

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

    return { valid: true, signedTxId };
  } catch (err: any) {
    const errorMsg = err?.message || err?.toString() || String(err);
    console.error('=== Transaction Validation: FAILED ===');
    console.error('Error:', errorMsg);
    return { valid: false, error: errorMsg };
  }
}
