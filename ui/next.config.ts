import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // The API routes import ../src/db/schema.ts — the Drizzle mirror of the SQL
    // migrations, which lives at the repo root and is shared with the daemon. Next
    // refuses to compile files outside its own root directory without this. Chosen
    // deliberately over restructuring the repo into npm workspaces: the daemon's
    // package.json is installed globally as the `kbagent` binary and must not grow a
    // Next dependency tree, and one shared file does not justify a packages/* rewrite.
    externalDir: true,
  },
};

export default nextConfig;
