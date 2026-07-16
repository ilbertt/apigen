import postgres from 'postgres';

// Hard-coded for the example — point this at your Postgres.
export const db = postgres('postgres://postgres:postgres@localhost:5432/apigen');
