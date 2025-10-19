// NOVO CONTEÚDO DE services/users-service/src/index.js
import app from './app.js';

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`[users] listening on http://localhost:${PORT}`);
});