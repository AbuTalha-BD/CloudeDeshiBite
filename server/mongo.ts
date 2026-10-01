import { MongoClient, Db, ServerApiVersion } from 'mongodb';
import fs from 'fs';
import path from 'path';
import type {
  Product,
  User,
  Sale,
  StockTransaction,
  PaymentRecord,
  AppNotification,
  AdminLog,
  BusinessSettings,
  MongoStatus,
} from '../src/types.js';

interface DatabaseSchema {
  products: Product[];
  users: User[];
  sales: Sale[];
  stockTransactions: StockTransaction[];
  payments: PaymentRecord[];
  notifications: AppNotification[];
  logs: AdminLog[];
  settings: BusinessSettings;
}

// Writable storage directory helper (with safe fallback for read-only serverless filesystems like Vercel)
export function getWritableDataDir(): string {
  try {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, 'ok', 'utf-8');
    fs.unlinkSync(testFile);
    return dataDir;
  } catch {
    // If process.cwd() is read-only (e.g. Vercel serverless environment), fallback to /tmp
    const tmpDir = path.join('/tmp', 'deshi_bite_data');
    if (!fs.existsSync(tmpDir)) {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch (e) {
        // ignore
      }
    }
    return tmpDir;
  }
}

const CONFIG_FILE = path.join(getWritableDataDir(), 'mongo_config.json');

// Helper to sanitize and auto-extract MongoDB connection URI from accidental env var syntax or pasted text
export function sanitizeMongoInput(input: string): { uri: string; dbName?: string; error?: string } {
  if (!input) return { uri: '' };
  let str = input.trim();

  let extractedDbName: string | undefined;

  // Extract MONGODB_DB_NAME if present (e.g. MONGODB_DB_NAME=deshi_bite)
  const dbMatch = str.match(/MONGODB_DB_NAME\s*=\s*['"]?([a-zA-Z0-9_\-]+)['"]?/i);
  if (dbMatch && dbMatch[1]) {
    extractedDbName = dbMatch[1].trim();
  }

  // If there's MONGODB_URI=... in the pasted string
  const uriVarMatch = str.match(/MONGODB_URI\s*=\s*['"]?([^\s'"]+)['"]?/i);
  if (uriVarMatch && uriVarMatch[1]) {
    str = uriVarMatch[1].trim();
  }

  // If the string contains mongodb:// or mongodb+srv:// anywhere inside it
  const schemeMatch = str.match(/(mongodb(?:\+srv)?:\/\/[^\s'"]+)/i);
  if (schemeMatch && schemeMatch[1]) {
    str = schemeMatch[1].trim();
  }

  // Clean accidental wrapping quotes or semicolons from copy-paste
  str = str.replace(/^["'`]|["'`;,]$/g, '').trim();

  if (str.includes('<password>') || str.includes('<db_password>')) {
    return {
      uri: str,
      dbName: extractedDbName,
      error: 'Please replace "<password>" in your connection string with your actual MongoDB database user password.',
    };
  }

  if (str && !str.startsWith('mongodb://') && !str.startsWith('mongodb+srv://')) {
    return {
      uri: str,
      dbName: extractedDbName,
      error: 'Invalid scheme, expected connection string to start with "mongodb://" or "mongodb+srv://"',
    };
  }

  return { uri: str, dbName: extractedDbName };
}

// Helper to determine the best available MongoDB URI
function resolveConfiguredUri(): string {
  // 1. Environment variable (Vercel -> Settings -> Environment Variables). Most reliable on serverless.
  const envUri = process.env.MONGODB_URI?.trim();
  if (envUri && !envUri.startsWith('your_')) {
    const { uri } = sanitizeMongoInput(envUri);
    if (uri) return uri;
  }

  // 2. Saved config from a previous successful connection (only survives on a persistent server)
  try {
    const possibleConfigFiles = [
      CONFIG_FILE,
      path.join(process.cwd(), 'data', 'mongo_config.json'),
      path.join('/tmp', 'deshi_bite_data', 'mongo_config.json'),
    ];
    for (const cf of possibleConfigFiles) {
      if (fs.existsSync(cf)) {
        const parsed = JSON.parse(fs.readFileSync(cf, 'utf-8'));
        if (parsed.uri && typeof parsed.uri === 'string' && parsed.uri.trim() !== '') {
          const { uri } = sanitizeMongoInput(parsed.uri);
          if (uri) return uri;
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // 3. Local .env file (local development)
  try {
    const envFile = path.join(process.cwd(), '.env');
    if (fs.existsSync(envFile)) {
      const match = fs.readFileSync(envFile, 'utf-8').match(/^MONGODB_URI=(.+)$/m);
      if (match && match[1] && !match[1].startsWith('your_') && match[1].trim() !== '') {
        const { uri } = sanitizeMongoInput(match[1]);
        if (uri) return uri;
      }
    }
  } catch (e) {
    // ignore
  }
  return '';
}

// Memory references
let client: MongoClient | null = null;
let db: Db | null = null;
let isConnected = false;
let lastError: string | null = null;
let activeUri: string = resolveConfiguredUri();
let DB_NAME = process.env.MONGODB_DB_NAME || 'deshi_bite';

export function maskMongoUri(uri: string): string {
  if (!uri) return '';
  return uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@.+)/i, '$1*****$3');
}

export function getActiveUri(): string {
  return activeUri;
}

export function isMongoActive(): boolean {
  return isConnected && db !== null;
}

export async function connectMongo(customUri?: string): Promise<{ success: boolean; message: string }> {
  const rawInput = customUri?.trim() || activeUri?.trim() || process.env.MONGODB_URI?.trim() || '';

  if (!rawInput) {
    isConnected = false;
    lastError = 'No MongoDB URI configured. Running in local persistence mode.';
    return { success: false, message: lastError };
  }

  const { uri: uriToUse, dbName: extractedDb, error: validationError } = sanitizeMongoInput(rawInput);

  if (validationError) {
    isConnected = false;
    lastError = validationError;
    return { success: false, message: validationError };
  }

  if (extractedDb) {
    DB_NAME = extractedDb;
  }

  // Reuse existing healthy connection if already connected to this URI
  if (isConnected && client && db && uriToUse === activeUri) {
    try {
      await db.command({ ping: 1 });
      return { success: true, message: `Connected to MongoDB database "${db.databaseName}" (cached)` };
    } catch {
      // Connection might be stale, proceed to reconnect
    }
  }

  try {
    // Close existing client if any
    if (client) {
      try {
        await client.close();
      } catch (e) {
        // ignore
      }
    }

    console.log(`[MongoDB] Attempting to connect to MongoDB Atlas... (${maskMongoUri(uriToUse)})`);

    // Determine target database name (extract from URI path if present, otherwise default to deshi_bite)
    let targetDbName = DB_NAME || process.env.MONGODB_DB_NAME || 'deshi_bite';
    try {
      const pseudoUrl = uriToUse.replace('mongodb+srv://', 'http://').replace('mongodb://', 'http://');
      const parsed = new URL(pseudoUrl);
      const extractedDb = parsed.pathname.replace(/^\//, '').split('?')[0].trim();
      if (extractedDb && extractedDb !== '/' && extractedDb !== 'hi_bite') {
        targetDbName = extractedDb;
      }
    } catch {
      // ignore
    }

    if (!targetDbName || targetDbName === '/' || targetDbName === 'hi_bite') {
      targetDbName = process.env.MONGODB_DB_NAME || 'deshi_bite';
    }
    
    // Connect with optimized options for cloud environments and serverless (Vercel, container)
    client = new MongoClient(uriToUse, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      retryWrites: true,
      tls: true,
    });

    await client.connect();
    // Ping database
    await client.db(targetDbName).command({ ping: 1 });

    db = client.db(targetDbName);
    DB_NAME = targetDbName;
    isConnected = true;
    lastError = null;
    activeUri = uriToUse;

    // Save configuration for persistence (try writable directory and /tmp fallback)
    try {
      const dir = getWritableDataDir();
      const targetConfig = path.join(dir, 'mongo_config.json');
      fs.writeFileSync(targetConfig, JSON.stringify({ uri: uriToUse, dbName: targetDbName, updatedAt: new Date().toISOString() }), 'utf-8');
    } catch (e) {
      console.warn('[MongoDB] Notice saving mongo_config.json:', e);
    }

    console.log(`[MongoDB] Connected successfully to MongoDB Cloud database: "${targetDbName}"`);
    return { success: true, message: `Connected to MongoDB database "${targetDbName}" successfully!` };
  } catch (err: any) {
    isConnected = false;
    let errMsg = err.message || 'Failed to connect to MongoDB';
    if (errMsg.includes('Server selection timed out') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ECONNREFUSED')) {
      errMsg = `${errMsg}. Ensure that '0.0.0.0/0' (Allow Access From Anywhere) is added to your MongoDB Atlas Network Access IP whitelist.`;
    }
    lastError = errMsg;
    console.warn(`[MongoDB] Connection notice: ${lastError}`);
    return { success: false, message: lastError };
  }
}

export async function getMongoStatus(): Promise<MongoStatus> {
  const dt = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka' });

  if (!isConnected || !db) {
    return {
      connected: false,
      database: DB_NAME,
      hasUri: Boolean(activeUri),
      maskedUri: maskMongoUri(activeUri),
      error: lastError,
      lastChecked: dt,
      source: 'local',
    };
  }

  try {
    const [productsCount, usersCount, salesCount, stockCount, paymentsCount, logsCount, notifsCount] = await Promise.all([
      db.collection('products').countDocuments(),
      db.collection('users').countDocuments(),
      db.collection('sales').countDocuments(),
      db.collection('stock_transactions').countDocuments(),
      db.collection('payments').countDocuments(),
      db.collection('logs').countDocuments(),
      db.collection('notifications').countDocuments(),
    ]);

    return {
      connected: true,
      database: DB_NAME,
      hasUri: true,
      maskedUri: maskMongoUri(activeUri),
      error: null,
      lastChecked: dt,
      source: 'mongodb',
      counts: {
        products: productsCount,
        users: usersCount,
        sales: salesCount,
        stockTransactions: stockCount,
        payments: paymentsCount,
        logs: logsCount,
        notifications: notifsCount,
      },
    };
  } catch (err: any) {
    return {
      connected: false,
      database: DB_NAME,
      hasUri: Boolean(activeUri),
      maskedUri: maskMongoUri(activeUri),
      error: err.message || 'Error pinging MongoDB collections',
      lastChecked: dt,
      source: 'local',
    };
  }
}

async function syncCollection(name: string, docs: any[]) {
  if (!db) return;
  const ids = docs.map((d) => d.id);
  if (docs.length > 0) {
    await db.collection(name).bulkWrite(
      docs.map((d) => ({
        replaceOne: { filter: { id: d.id }, replacement: { ...d, _id: d.id as any }, upsert: true },
      }))
    );
  }
  // remove documents that were deleted in the app
  await db.collection(name).deleteMany({ _id: { $nin: ids as any[] } });
}

// Push all local data into MongoDB (useful on initial connection or manual sync)
export async function pushAllToMongo(schema: DatabaseSchema): Promise<boolean> {
  if (!isConnected || !db) return false;

  try {
    await syncCollection('products', schema.products || []);
    await syncCollection('users', schema.users || []);
    await syncCollection('sales', schema.sales || []);
    await syncCollection('stock_transactions', schema.stockTransactions || []);
    await syncCollection('payments', schema.payments || []);
    await syncCollection('notifications', schema.notifications || []);
    await syncCollection('logs', schema.logs || []);

    // Settings
    if (schema.settings) {
      await db.collection('settings').replaceOne(
        { _id: 'global_settings' as any },
        { ...schema.settings, _id: 'global_settings' as any },
        { upsert: true }
      );
    }

    console.log('[MongoDB] All collections synced to MongoDB Cloud successfully.');
    return true;
  } catch (err) {
    console.error('[MongoDB] Error pushing state to MongoDB:', err);
    return false;
  }
}

// Pull latest state from MongoDB
export async function pullAllFromMongo(): Promise<DatabaseSchema | null> {
  if (!isConnected || !db) return null;

  try {
    const [products, users, sales, stockTransactions, payments, notifications, logs, settingsDoc] = await Promise.all([
      db.collection('products').find().toArray(),
      db.collection('users').find().toArray(),
      db.collection('sales').find().sort({ timestamp: -1 }).toArray(),
      db.collection('stock_transactions').find().sort({ timestamp: -1 }).toArray(),
      db.collection('payments').find().sort({ timestamp: -1 }).toArray(),
      db.collection('notifications').find().sort({ timestamp: -1 }).toArray(),
      db.collection('logs').find().sort({ timestamp: -1 }).toArray(),
      db.collection('settings').findOne({ _id: 'global_settings' as any }),
    ]);

    // If collections are completely empty, return null so caller can seed
    if (products.length === 0 && users.length === 0) {
      return null;
    }

    return {
      products: products.map((p: any) => {
        const { _id, ...rest } = p;
        return rest as Product;
      }),
      users: users.map((u: any) => {
        const { _id, ...rest } = u;
        return rest as User;
      }),
      sales: sales.map((s: any) => {
        const { _id, ...rest } = s;
        return rest as Sale;
      }),
      stockTransactions: stockTransactions.map((st: any) => {
        const { _id, ...rest } = st;
        return rest as StockTransaction;
      }),
      payments: payments.map((pm: any) => {
        const { _id, ...rest } = pm;
        return rest as PaymentRecord;
      }),
      notifications: notifications.map((n: any) => {
        const { _id, ...rest } = n;
        return rest as AppNotification;
      }),
      logs: logs.map((l: any) => {
        const { _id, ...rest } = l;
        return rest as AdminLog;
      }),
      settings: settingsDoc
        ? (({ _id, ...s }: any) => s as BusinessSettings)(settingsDoc)
        : ({} as BusinessSettings),
    };
  } catch (err) {
    console.error('[MongoDB] Error pulling data from MongoDB:', err);
    return null;
  }
}

// Real-time write operations to MongoDB
export async function mongoUpsert(collectionName: string, id: string, doc: any): Promise<void> {
  if (!isConnected || !db) return;
  try {
    await db.collection(collectionName).replaceOne(
      { id },
      { ...doc, _id: id as any },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[MongoDB] Failed to upsert document in ${collectionName}:`, err);
  }
}

export async function mongoInsert(collectionName: string, doc: any): Promise<void> {
  if (!isConnected || !db) return;
  try {
    const id = doc.id || `doc_${Date.now()}`;
    await db.collection(collectionName).replaceOne(
      { id },
      { ...doc, _id: id as any },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[MongoDB] Failed to insert in ${collectionName}:`, err);
  }
}

// Find user in MongoDB directly (used for instant auth check)
export async function getMongoUserByPhone(phone: string): Promise<User | null> {
  if (!isConnected || !db) return null;
  try {
    const doc = await db.collection('users').findOne({ phone: phone.trim() });
    if (!doc) return null;
    const { _id, ...safe } = doc as any;
    return safe as User;
  } catch (err) {
    console.warn('[MongoDB] Error querying user by phone:', err);
    return null;
  }
}

