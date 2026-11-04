// control-demo: the original file runs git in the Electron main process.
// The browser build only needs the types.
export type GitRefInfo = {
  hash: string;
  name: string;
  date: string;
};

export type RepoImportResult = {
  tags: GitRefInfo[];
  commits: GitRefInfo[];
  branches: GitRefInfo[];
};
