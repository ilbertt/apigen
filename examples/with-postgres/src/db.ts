import postgres from 'postgres';

export const db = postgres('postgres://postgres:postgres@localhost:5432/apigen');
