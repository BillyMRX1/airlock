// Deterministic side-effect classifier (plan §14).
//
// Layered detection, honestly scoped: these are *known* dangerous
// command shapes. Regex detection is NOT complete — the mod says so in
// every warning and never claims commands are sandboxed. Unknown
// commands pass through in every mode. Balanced mode asks only for
// recognized side effects; strict denies recognized patterns.

export interface SideEffectMatch {
  matched: boolean
  pattern: string
  reason: string
}

interface Rule {
  name: string
  test: RegExp
  reason: string
}

const RULES: Rule[] = [
  {
    name: 'git push',
    test: /\bgit\s+[^;&|]*\bpush\b/,
    reason: 'git push publishes commits to a remote repository',
  },
  {
    name: 'npm publish',
    test: /\b(npm|yarn|pnpm)\s+[^;&|]*\bpublish\b/,
    reason: 'package publishing is public and irreversible',
  },
  {
    name: 'docker destructive',
    test: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|image\s+(rm|prune)|container\s+(rm|prune))\b/,
    reason: 'docker deletion/prune commands destroy containers, images or volumes',
  },
  {
    name: 'kubectl mutation',
    test: /\bkubectl\s+[^;&|]*\b(apply|create|delete|scale|rollout|patch|replace)\b/,
    reason: 'kubectl mutations change remote cluster state',
  },
  {
    name: 'terraform apply/destroy',
    test: /\bterraform\s+(apply|destroy|import)\b/,
    reason: 'terraform changes real infrastructure',
  },
  {
    name: 'cloud CLI',
    test: /\b(aws|gcloud|az|doctl|linode-cli)\s+[^\s]/,
    reason: 'cloud CLI commands act on external resources',
  },
  {
    name: 'curl/wget mutation',
    test: /\b(curl|wget)\s+[^;&|]*(-X\s*(POST|PUT|PATCH|DELETE|TRACE)\b|--data(-raw|-binary|-urlencode)?\b|-d\b|--json\b|--form\b|-F\b|-T\b)/,
    reason: 'an HTTP request that writes or deletes on the remote side',
  },
  {
    name: 'ssh/scp/rsync remote',
    test: /\b(ssh|scp|rsync)\s+[^;&|]*[\w.-]+@/,
    reason: 'commands reaching a remote machine',
  },
  {
    name: 'gh release/merge',
    test: /\bgh\s+[^;&|]*\b(release|pr\s+merge|repo\s+delete)\b/,
    reason: 'GitHub release/merge operations are public and hard to undo',
  },
  {
    name: 'database exec',
    test: /\b(psql|mysql|mariadb|sqlite3)\s+[^;&|]*\s-c\s/,
    reason: 'a SQL command string sent to a database',
  },
  {
    name: 'publish tooling',
    test: /\b(twine\s+upload|gradle\s+[^;&|]*\bpublish\b|mvn\s+[^;&|]*\bdeploy\b|cargo\s+publish|go\b[^;&|]*\bpublish\b)/,
    reason: 'artifact publication is public and irreversible',
  },
]

export function classifySideEffect(command: string): SideEffectMatch {
  for (const rule of RULES) {
    if (rule.test.test(command)) {
      return { matched: true, pattern: rule.name, reason: rule.reason }
    }
  }
  return { matched: false, pattern: '', reason: '' }
}

export const SIDE_EFFECT_WARNING =
  'This command may cause effects outside the transaction workspace. Those effects cannot automatically be rolled back.'
