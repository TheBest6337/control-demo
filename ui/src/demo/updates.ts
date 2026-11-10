// control-demo: Setup → Update like on a real panel, from a snapshot of
// qitechgmbh/control (scripts/snapshot-versions.mjs, refreshed by sync-ui.sh).
// Versions, branches, master commits and their changelogs can be browsed;
// "Apply Update" explains that the demo does not install anything.

type Snapshot = {
  source: { githubRepoOwner: string; githubRepoName: string };
  createdAt: string;
  current: { commit: string; timestamp: string; abbreviation: string };
  tags: GitRef[];
  branches: GitRef[];
  commits: GitRef[];
  refs: Record<string, number>;
  changelogs: string[];
};
type GitRef = { hash: string; name: string; date: string };
type Source = { githubRepoOwner: string; githubRepoName: string };
type EndResult = { success: boolean; error?: string };

const NO_INSTALL =
  "This is a demo: updates are not installed. Nothing was downloaded or changed.";

// loaded on first use, so the snapshot (≈150 kB gzipped) never delays startup
let snapshot: Promise<Snapshot> | undefined;
const load = () =>
  (snapshot ??= import("./control-versions.json").then(
    (m) => (m.default ?? m) as Snapshot,
  ));

const isSnapshotSource = (s: Snapshot, source?: Source) =>
  !source ||
  (source.githubRepoOwner?.toLowerCase() ===
    s.source.githubRepoOwner.toLowerCase() &&
    source.githubRepoName?.toLowerCase() ===
      s.source.githubRepoName.toLowerCase());

const otherSource = (s: Snapshot) =>
  `the demo only includes ${s.source.githubRepoOwner}/${s.source.githubRepoName}`;

// a short pause, as if git had answered
const later = (fn: () => void, ms = 400) => setTimeout(fn, ms);

export const demoEnvironment = {
  getInfo: async () => {
    const s = await load();
    return {
      qitechOs: false, // true would start the fullscreen button in its "on" state
      qitechOsGitTimestamp: s.current.timestamp,
      qitechOsGitCommit: s.current.commit,
      qitechOsGitAbbreviation: s.current.abbreviation,
      qitechOsGitUrl: `https://github.com/${s.source.githubRepoOwner}/${s.source.githubRepoName}.git`,
    };
  },
};

export function createDemoUpdate() {
  let fetchTargetsCb: ((r: unknown) => void) | undefined;
  let changelogCb: ((r: string) => void) | undefined;
  let logCb: ((line: string) => void) | undefined;
  let endCb: ((r: EndResult) => void) | undefined;

  return {
    fetchTargets: async (source: Source) => {
      const s = await load();
      later(() =>
        fetchTargetsCb?.(
          isSnapshotSource(s, source)
            ? { tags: s.tags, branches: s.branches, commits: s.commits }
            : otherSource(s),
        ),
      );
    },
    fetchChangelog: async (source: Source, ref: string) => {
      const s = await load();
      const index = s.refs[ref];
      later(() =>
        changelogCb?.(
          !isSnapshotSource(s, source)
            ? otherSource(s)
            : index === undefined
              ? `fatal: path 'CHANGELOG.md' does not exist in '${ref}'`
              : s.changelogs[index],
        ),
      );
    },
    execute: async (params: Source & { tag?: string; branch?: string; commit?: string }) => {
      const target = params.tag ?? params.branch ?? params.commit?.slice(0, 8);
      const lines = [
        `Selected ${params.githubRepoOwner}/${params.githubRepoName} @ ${target}`,
        "On a QiTech panel the update now clones the repository, builds the",
        "software and installs it as a new system version, then reboots.",
        NO_INSTALL,
      ];
      lines.forEach((line, i) => later(() => logCb?.(line), 300 * (i + 1)));
      later(
        () => endCb?.({ success: false, error: NO_INSTALL }),
        300 * (lines.length + 1),
      );
    },
    cancel: async () => ({ success: true }),
    // the demo runs "master", so control would not offer a release either
    checkLatestRelease: async () => ({ latest: null }),

    onFetchTargetsRecv: async (cb: typeof fetchTargetsCb) => {
      fetchTargetsCb = cb;
    },
    onFetchChangelog: async (cb: typeof changelogCb) => {
      changelogCb = cb;
    },
    onLog: (cb: typeof logCb) => {
      logCb = cb;
    },
    onEnd: (cb: typeof endCb) => {
      endCb = cb;
    },
    onStep: () => {},

    hasToken: async () => false,
    saveToken: async () => ({
      success: false,
      error: "Access tokens are not used in the demo.",
    }),
    loadTokenFromFile: async () => ({
      success: false,
      error: "Access tokens are not used in the demo.",
    }),
    clearToken: async () => ({ success: true }),
  };
}

/** "Installed Versions": the running version and the two releases before it. */
export function createDemoNixos() {
  let generations: NixOSGeneration[] | undefined;
  const list = async () => {
    if (!generations) {
      const s = await load();
      const [latest, previous] = s.tags.filter((t) => !t.name.includes("-"));
      const entry = (
        id: number,
        label: string,
        commit: string,
        date: string,
        current = false,
      ): NixOSGeneration => ({
        id: String(id),
        name: `${label}_${commit}`,
        version: "26.05",
        current,
        date,
        path: `/nix/var/nix/profiles/system-${id}-link`,
        kernelVersion: "6.18",
      });
      generations = [
        entry(14, s.current.abbreviation, s.current.commit, s.current.timestamp, true),
        ...(latest ? [entry(13, latest.name, latest.hash, latest.date)] : []),
        ...(previous ? [entry(12, previous.name, previous.hash, previous.date)] : []),
      ];
    }
    return generations.map((g) => ({ ...g }));
  };
  return {
    isNixOSAvailable: true,
    listGenerations: list,
    setGeneration: async (id: string) => {
      await list();
      generations = generations!.map((g) => ({ ...g, current: g.id === id }));
    },
    deleteGeneration: async (id: string) => {
      await list();
      generations = generations!.filter((g) => g.id !== id || g.current);
    },
    deleteAllOldGenerations: async () => {
      await list();
      generations = generations!.filter((g) => g.current);
    },
  };
}
