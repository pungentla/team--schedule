export function randomInt(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 0x100000000) throw new Error('随机范围无效');
  const value = new Uint32Array(1), ceiling = Math.floor(0x100000000 / limit) * limit;
  do { globalThis.crypto.getRandomValues(value); } while (value[0] >= ceiling);
  return value[0] % limit;
}
export function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function parseNames(text, { min = 2, max = 50 } = {}) {
  const names = text.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  if (names.length < min || names.length > max) throw new Error(`请填写 ${min}–${max} 项，每行一项`);
  if (names.some(name => [...name].length > 80)) throw new Error('每项最多 80 个字');
  if (new Set(names).size !== names.length) throw new Error('有重复的名称，请区分后重试');
  return names;
}
export function draw(names, count) {
  if (!Number.isInteger(count) || count < 1 || count > names.length) throw new Error('抽取数量应在 1 和候选数量之间');
  return shuffle(names).slice(0, count);
}
export function makeGroups(names, count) {
  if (!Number.isInteger(count) || count < 2 || count > names.length) throw new Error('组数应在 2 和人数之间');
  const groups = Array.from({ length: count }, () => []);
  shuffle(names).forEach((name, i) => groups[i % count].push(name));
  return groups;
}
