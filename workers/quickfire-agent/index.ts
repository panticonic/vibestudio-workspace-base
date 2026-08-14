export { QuickfireAgentWorker } from "./quickfire-agent-worker.js";

export default {
  fetch(_request: Request): Response {
    return new Response("quickfire-agent worker");
  },
};
