import postgres from 'postgres';

export const db = postgres(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/apigen',
);
