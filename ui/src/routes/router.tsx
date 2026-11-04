import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { rootTree } from "./routes";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const history = createMemoryHistory({
  initialEntries: ["/_sidebar/machines/winder2/1/control"], // control-demo: start on a running machine
});
export const router = createRouter({ routeTree: rootTree, history: history });
