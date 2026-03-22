/**
 * Initialize the database by importing the db module.
 * The db module auto-creates tables on first import.
 */
const { default: db } = await import('../src/db.ts');
console.log('Database initialized successfully.');
process.exit(0);
