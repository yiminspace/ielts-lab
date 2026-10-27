import { VoyageToolbar } from "@yiminlab/voyage/react";
import { VoyageAuthMenu } from "@yiminlab/authkit/voyage";
import { useRuntime } from "../lib/runtime";

export default function AccountTools() {
  const { config, authOptions } = useRuntime();
  return (
    <VoyageToolbar
      locale="zh"
      palette={false}
      account={
        config.authRequired ? (
          <VoyageAuthMenu locale="zh" authOptions={authOptions} />
        ) : undefined
      }
    />
  );
}
