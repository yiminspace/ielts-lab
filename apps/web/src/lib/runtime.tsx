import { createContext, useContext } from "react";
import type { UseAuthOptions } from "@yiminlab/authkit";

export interface ClientConfig {
  authRequired: boolean;
  authkitApiUrl: string;
  publicOrigin: string;
}
export interface RuntimeValue {
  config: ClientConfig;
  userId: string | null;
  authOptions?: UseAuthOptions;
}
export const RuntimeContext = createContext<RuntimeValue>({
  config: { authRequired: false, authkitApiUrl: "", publicOrigin: "" },
  userId: null,
});
export const useRuntime = () => useContext(RuntimeContext);
