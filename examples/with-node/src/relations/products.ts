import { relation } from '../api.gen.ts';

export const products = relation('products').select({
  beforeExecute: ({ op, relation }) => {
    console.log(`Handling ${op} on ${relation}`);
  },
  afterExecute: ({ relation, response }) => {
    response.headers.set('x-apigen-relation', relation);
    return response;
  },
});
