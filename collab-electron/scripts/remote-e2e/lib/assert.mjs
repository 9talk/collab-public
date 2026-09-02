import { existsSync, readFileSync, statSync } from "node:fs";

const results = [];

export function record(scenario, name, pass, detail = "") {
  results.push({ scenario, name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${scenario}/${name}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

export function assertLog(logPath, pattern, scenario, name, detail = "") {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  let text = "";
  try {
    text = readFileSync(logPath, "utf-8");
  } catch {
    // missing log
  }
  const pass = re.test(text);
  return record(
    scenario,
    name,
    pass,
    pass ? detail : `${detail}; 日志 ${logPath} 未匹配 ${re}`,
  );
}

export function assertFile(path, scenario, name, opts = {}) {
  const pass = existsSync(path);
  if (pass && opts.content) {
    const content = readFileSync(path, "utf-8");
    const ok = content.includes(opts.content);
    return record(
      scenario,
      name,
      ok,
      ok
        ? `${path} 含 "${opts.content}"`
        : `${path} 内容不含 "${opts.content}"`,
    );
  }
  return record(scenario, name, pass, pass ? `${path} 存在` : `${path} 不存在`);
}

export function assertFileGrew(path, prevMtime, scenario, name) {
  let cur = prevMtime;
  try {
    cur = statSync(path).mtimeMs;
  } catch {
    // missing
  }
  const pass = cur > prevMtime;
  return record(
    scenario,
    name,
    pass,
    pass ? `${path} mtime 更新` : `${path} 未更新`,
  );
}

export function summary() {
  const failed = results.filter((r) => !r.pass);
  console.log("");
  console.log(`共 ${results.length} 个断言, ${failed.length} 个失败`);
  for (const r of failed) {
    console.log(`  FAIL ${r.scenario}/${r.name}`);
  }
  return failed.length === 0;
}
