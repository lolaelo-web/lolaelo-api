import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));

app.get('/healthz', (_req: Request, res: Response) => res.json({ ok: true }));
app.get('/', (_req: Request, res: Response) => res.send('Lolaelo API is running.'));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));
