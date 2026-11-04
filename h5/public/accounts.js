'use strict';
const accountRoles = { employee: '员工', admin: '管理员', super_admin: '超级管理员' };
function accountFields(user = {}) {
  const superAdmin = state.user.role === 'super_admin';
  return `<label class="field">登录账号（工号）<input name="employeeNo" value="${escapeHtml(user.employeeNo || '')}" required pattern="(?:[A-Za-z0-9_]|-){2,32}" minlength="2" maxlength="32" autocomplete="username"></label>
    <label class="field">姓名<input name="name" value="${escapeHtml(user.name || '')}" required maxlength="32"></label>
    <label class="field">手机号<input name="phone" value="${escapeHtml(user.phone || '')}" maxlength="32" inputmode="tel"></label>
    ${user.role === 'super_admin' ? '<p class="form-help">超级管理员</p>' : `<label class="field">角色<select name="role">${(superAdmin ? ['employee', 'admin'] : ['employee']).map((role) => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${accountRoles[role]}</option>`).join('')}</select></label>`}
    ${user.id ? (user.role === 'super_admin' ? '' : `<label class="field">状态<select name="status"><option value="active">启用</option><option value="disabled" ${user.status === 'disabled' ? 'selected' : ''}>停用</option></select></label>`) : '<label class="field">初始密码<input name="password" type="password" required minlength="6" maxlength="128" autocomplete="new-password"></label>'}`;
}
async function renderAccounts() {
  const box = $('#account-config');
  if (!isAdminUser()) return;
  box.textContent = '正在加载账号…';
  try {
    const users = await API.adminUsers();
    if (!isAdminUser()) return;
    box.innerHTML = `
    <details><summary>＋ 新建账号</summary><form data-account-id="">${accountFields()}<p class="form-error" role="alert"></p><button type="submit" class="btn-success">创建账号</button></form></details>
    ${users.map((u) => {
      const editable = u.role === 'employee' || (state.user.role === 'super_admin' && (u.role !== 'super_admin' || u.id === state.user.id));
      return `<details><summary>${escapeHtml(u.name)} · ${escapeHtml(u.employeeNo)} · ${accountRoles[u.role]} · ${u.status === 'active' ? '启用' : '停用'}</summary>${editable ? `<form data-account-id="${u.id}">${accountFields(u)}<p class="form-error" role="alert"></p><button class="btn-ghost" type="submit">保存账号设置</button></form><form data-password-id="${u.id}"><input type="hidden" autocomplete="username" value="${escapeHtml(u.employeeNo)}"><label class="field">重置密码<input name="newPassword" type="password" required minlength="6" maxlength="128" autocomplete="new-password"></label><p class="form-error" role="alert"></p><button type="submit" class="btn-ghost">重置密码（需重新登录）</button></form>` : '<p class="form-help">此账号由超级管理员管理。</p>'}</details>`;
    }).join('')}`;
  } catch (err) { box.innerHTML = errorMarkup(err); }
}
function bindAccountEvents() {
  $('#account-config').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    form.querySelector('.form-error').textContent = '';
    try {
      const id = Number(form.dataset.accountId || form.dataset.passwordId);
      if (form.dataset.passwordId) await API.resetUserPassword(id, form.elements.newPassword.value);
      else await API.saveUser(id || null, Object.fromEntries(new FormData(form)));
      if (id === state.user.id) { await doLogout(); toast('账号已更新，请重新登录'); return; }
      toast(form.dataset.passwordId ? '密码已重置，该账号需要重新登录' : '账号设置已保存');
      await renderAccounts();
    } catch (err) { form.querySelector('.form-error').textContent = employeeError(err); }
    finally { button.disabled = false; }
  });
}
