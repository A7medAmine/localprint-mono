import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { updateSetting } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_JSON_FILE = path.join(__dirname, 'db.json');

const migrate = () => {
  if (!fs.existsSync(DB_JSON_FILE)) {
    console.log('⚠️ db.json not found, skipping migration.');
    return;
  }

  console.log('🚀 Starting migration from db.json to SQLite...');

  try {
    const data = JSON.parse(fs.readFileSync(DB_JSON_FILE, 'utf-8'));
    
    // Migrate Jobs
    const jobs = data.jobs || [];
    const insertJob = db.prepare(`
      INSERT OR REPLACE INTO jobs (
        id, customerName, phoneNumber, notes, fileName, fileType, 
        fileSize, uploadDate, status, serverFileName, pageCount, 
        colorMode, copies
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertManyJobs = db.transaction((jobs) => {
      for (const job of jobs) {
        insertJob.run(
          job.id,
          job.customerName,
          job.phoneNumber,
          job.notes,
          job.fileName,
          job.fileType,
          job.fileSize,
          job.uploadDate,
          job.status,
          job.serverFileName,
          job.pageCount || null,
          job.printPreferences?.colorMode || 'color',
          job.printPreferences?.copies || 1
        );
      }
    });

    insertManyJobs(jobs);
    console.log(`✅ Migrated ${jobs.length} jobs.`);

    // Migrate Settings
    const settings = data.settings || {};
    for (const [key, value] of Object.entries(settings)) {
      updateSetting(key, value);
    }
    console.log('✅ Migrated settings.');

    console.log('🎉 Migration completed successfully!');
    
    // Optional: Rename old db.json to prevent re-migration or accidental data loss
    const backupFile = path.join(__dirname, `db.json.bak_${Date.now()}`);
    fs.renameSync(DB_JSON_FILE, backupFile);
    console.log(`📦 Original db.json backed up to: ${path.basename(backupFile)}`);

  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
};

migrate();
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
