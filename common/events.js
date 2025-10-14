/*
ERRO:
orders-service@1.0.0 start > node src/index.js file:///app/src/index.js:6
import { ROUTING_KEYS } from '../common/events.js';
SyntaxError: The requested module '../common/events.js'
does not provide an export named 'ROUTING_KEYS' at ModuleJob._instantiate
(node:internal/modules/esm/module_job:213:21) at async ModuleJob.run
(node:internal/modules/esm/module_job:320:5) at async ModuleLoader.import
(node:internal/modules/esm/loader:606:24) at async asyncRunEntryPointWithESMLoader
(node:internal/modules/run_main:117:5) Node.js v20.19.5
*/

// Alterei o module.exports para export const
export const ROUTING_KEYS = {
  USER_CREATED: 'user.created',
  ORDER_CREATED: 'order.created'
};

// ANTIGO COM ERRO
// module.exports = {
//   ROUTING_KEYS: {
//     USER_CREATED: 'user.created',
//     ORDER_CREATED: 'order.created'
//   }
// };
