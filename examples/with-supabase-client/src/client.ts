import { createClient } from '@supabase/supabase-js';

// apigen is PostgREST-compatible, so the official supabase-js client talks to it with
// no shim. The "anon key" is just the bearer token auth() resolves: supabase-js sends
// it as `Authorization: Bearer <key>`, which is exactly what apigen reads. `tok_ada`
// maps to the seeded customer Ada.
const supabase = createClient(process.env.APIGEN_URL ?? 'http://localhost:3000', 'tok_ada');

const ADA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// products: public catalog. `.order(..., { ascending: false })` becomes `?order=price.desc`.
const productsResult = await supabase
  .from('products')
  .select('name,price')
  .order('price', { ascending: false });
console.log('products:', productsResult.data ?? productsResult.error);

// orders: scoped to Ada by the select policy — Grace's order never comes back.
const ordersResult = await supabase.from('orders').select('*');
console.log('orders:', ordersResult.data ?? ordersResult.error);

// insert: the WITH CHECK policy requires customer_id to be the caller. `.select()`
// asks apigen to return the created row.
const createResult = await supabase
  .from('orders')
  .insert({ customer_id: ADA, status: 'pending', total: 42 })
  .select();
console.log('created:', createResult.data ?? createResult.error);
