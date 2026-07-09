// WebFetch 预批准域名 —— 移植自 cc-haha src/tools/WebFetchTool/preapproved.ts。
// 仅用于 WebFetch(只读 GET)白名单:命中即不弹审批。沙箱网络限制「故意不」继承这份表
// (这些域里有的允许上传,任意网络访问会成为外泄通道),对齐 cc 的安全说明。
export const PREAPPROVED_HOSTS = new Set([
  // Anthropic
  'platform.claude.com', 'code.claude.com', 'modelcontextprotocol.io', 'github.com/anthropics', 'agentskills.io',
  // 主流编程语言
  'docs.python.org', 'en.cppreference.com', 'docs.oracle.com', 'learn.microsoft.com', 'developer.mozilla.org',
  'go.dev', 'pkg.go.dev', 'www.php.net', 'docs.swift.org', 'kotlinlang.org', 'ruby-doc.org', 'doc.rust-lang.org',
  'www.typescriptlang.org',
  // Web / JS 框架库
  'react.dev', 'angular.io', 'vuejs.org', 'nextjs.org', 'expressjs.com', 'nodejs.org', 'bun.sh', 'jquery.com',
  'getbootstrap.com', 'tailwindcss.com', 'd3js.org', 'threejs.org', 'redux.js.org', 'webpack.js.org', 'jestjs.io',
  'reactrouter.com',
  // Python 框架库
  'docs.djangoproject.com', 'flask.palletsprojects.com', 'fastapi.tiangolo.com', 'pandas.pydata.org', 'numpy.org',
  'www.tensorflow.org', 'pytorch.org', 'scikit-learn.org', 'matplotlib.org', 'requests.readthedocs.io', 'jupyter.org',
  // PHP
  'laravel.com', 'symfony.com', 'wordpress.org',
  // Java
  'docs.spring.io', 'hibernate.org', 'tomcat.apache.org', 'gradle.org', 'maven.apache.org',
  // .NET / C#
  'asp.net', 'dotnet.microsoft.com', 'nuget.org', 'blazor.net',
  // 移动端
  'reactnative.dev', 'docs.flutter.dev', 'developer.apple.com', 'developer.android.com',
  // 数据科学 / ML
  'keras.io', 'spark.apache.org', 'huggingface.co', 'www.kaggle.com',
  // 数据库
  'www.mongodb.com', 'redis.io', 'www.postgresql.org', 'dev.mysql.com', 'www.sqlite.org', 'graphql.org', 'prisma.io',
  // 云 / DevOps
  'docs.aws.amazon.com', 'cloud.google.com', 'kubernetes.io', 'www.docker.com', 'www.terraform.io', 'www.ansible.com',
  'vercel.com/docs', 'docs.netlify.com', 'devcenter.heroku.com',
  // 测试 / 监控
  'cypress.io', 'selenium.dev',
  // 游戏
  'docs.unity.com', 'docs.unrealengine.com',
  // 其它核心工具
  'git-scm.com', 'nginx.org', 'httpd.apache.org',
])

export const PREAPPROVED_HOSTS_COUNT = PREAPPROVED_HOSTS.size

// 加载时拆一次:纯主机名走 O(1) Set.has;少数带路径前缀的(如 "github.com/anthropics")走小的前缀表。
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>()
  const paths = new Map<string, string[]>()
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf('/')
    if (slash === -1) {
      hosts.add(entry)
    } else {
      const host = entry.slice(0, slash)
      const path = entry.slice(slash)
      const prefixes = paths.get(host)
      if (prefixes) prefixes.push(path)
      else paths.set(host, [path])
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths }
})()

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (HOSTNAME_ONLY.has(host)) return true
  const prefixes = PATH_PREFIXES.get(host)
  if (prefixes) {
    for (const p of prefixes) {
      // 强制路径段边界:"/anthropics" 不能匹配 "/anthropics-evil/malware"。
      if (pathname === p || pathname.startsWith(p + '/')) return true
    }
  }
  return false
}
