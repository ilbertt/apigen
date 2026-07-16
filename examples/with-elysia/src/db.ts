import { SQL } from 'bun';

// Hard-coded for the example — point this at your Postgres.
export const db = new SQL('postgres://postgres:postgres@localhost:5432/apigen');
