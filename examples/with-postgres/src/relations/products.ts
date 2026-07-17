import { relation } from '../api.gen.ts';

export const products = relation('products').select({
  beforeExecute: ({ op, relation }) => {
    void fetch('https://o11y.example/ingest', {
      method: 'POST',
      body: JSON.stringify({ op, relation }),
    }).catch(() => {});
  },
  afterExecute: ({ relation, response }) => {
    response.headers.set('x-apigen-relation', relation);
    return response;
  },
});
