import { createApiApp } from './app.ts';

const app = createApiApp({ ensureDbOnRequest: true });

export default app;
