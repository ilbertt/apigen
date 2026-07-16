import { SQL } from 'bun';

export const db = new SQL('postgres://postgres:postgres@localhost:5432/apigen');
