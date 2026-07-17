import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { videos } from './videos.ts';

const app = new Apigen({ db }).use(videos);

const port = Number(process.env.PORT) || 3000;
const server = Bun.serve({ port, fetch: app.handle });
console.log(`listening on ${server.url}`);
