export const MAX_PARALLEL_DEVELOPERS = 4;

function normalizePath(value) {
  if (typeof value !== "string") {
    throw new Error("文件范围必须是字符串");
  }

  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path) throw new Error("文件范围不能为空");
  if (path === ".") return path;
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path === ".." || path.startsWith("../")) {
    throw new Error(`文件范围必须位于项目内：${value}`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`文件范围不能包含父目录：${value}`);
  }
  if (path === ".git" || path.startsWith(".git/")) {
    throw new Error(`不能修改 Git 元数据：${value}`);
  }
  if (/[\*\?\[\]]/.test(path)) {
    throw new Error(`文件范围不支持通配符，请填写文件或目录：${value}`);
  }
  return path;
}

function pathsOverlap(left, right) {
  return left === "." || right === "." || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function validateParallelTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 2) {
    throw new Error("parallel_develop 至少需要 2 个开发测试任务");
  }
  if (tasks.length > MAX_PARALLEL_DEVELOPERS) {
    throw new Error(`parallel_develop 最多支持 ${MAX_PARALLEL_DEVELOPERS} 个并行任务`);
  }

  const ids = new Set();
  const normalized = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") throw new Error("开发测试任务格式无效");

    const id = typeof task.id === "string" ? task.id.trim() : "";
    if (!id) throw new Error("每个开发测试任务都需要 id");
    if (ids.has(id)) throw new Error(`开发测试任务 id 重复：${id}`);
    ids.add(id);

    const description = typeof task.task === "string" ? task.task.trim() : "";
    if (!description) throw new Error(`任务 ${id} 缺少 task`);

    if (!Array.isArray(task.files) || task.files.length === 0) {
      throw new Error(`任务 ${id} 必须声明至少一个 files 范围`);
    }
    const files = [...new Set(task.files.map(normalizePath))];
    normalized.push({ id, task: description, files });
  }

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const left = normalized[i];
      const right = normalized[j];
      for (const leftPath of left.files) {
        for (const rightPath of right.files) {
          if (pathsOverlap(leftPath, rightPath)) {
            throw new Error(`任务 ${left.id} 与 ${right.id} 的文件范围重叠：${leftPath} / ${rightPath}`);
          }
        }
      }
    }
  }

  return normalized;
}

export function isPathAllowed(file, scopes) {
  const normalized = normalizePath(file);
  return scopes.some((scope) => scope === "." || normalized === scope || normalized.startsWith(`${scope}/`));
}
