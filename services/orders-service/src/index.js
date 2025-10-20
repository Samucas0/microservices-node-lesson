// CONTEÚDO ATUALIZADO DE: services/orders-service/src/index.js
import app from './app.js';

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`[orders] listening on http://localhost:${PORT}`);
});