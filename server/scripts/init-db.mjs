/**
 * Initialize the database — creates all tables and seeds default data.
 */
const { initializeDatabase } = await import('../src/db.ts');
await initializeDatabase();
console.log('Database initialized successfully.');
process.exit(0);
