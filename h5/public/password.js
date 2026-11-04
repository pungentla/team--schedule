'use strict';
let passwordSaving = false;
function resetPasswordForm() {
  $('#password-form').reset();
  $('#password-error').textContent = '';
  $('#password-dialog').close();
}
function bindPasswordEvents() {
  $('#btn-account').addEventListener('click', () => {
    resetPasswordForm();
    $('#password-account').textContent = `${state.user.name}（${state.user.employeeNo}）`;
    $('#password-dialog').showModal();
  });
  $('#btn-password-close').addEventListener('click', () => { if (!passwordSaving) resetPasswordForm(); });
  $('#password-dialog').addEventListener('cancel', (event) => { if (passwordSaving) event.preventDefault(); else resetPasswordForm(); });
  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (passwordSaving) return;
    const form = event.target;
    const oldPassword = form.elements.oldPassword.value.trim();
    const newPassword = form.elements.newPassword.value.trim();
    const confirmation = form.elements.confirmPassword.value.trim();
    const error = $('#password-error');
    if (newPassword !== confirmation) { error.textContent = '两次新密码不一致'; return; }
    if (newPassword.length < 6 || newPassword.length > 128) { error.textContent = '新密码需为 6–128 位'; return; }
    if (oldPassword === newPassword) { error.textContent = '新密码不能与原密码相同'; return; }
    passwordSaving = true; error.textContent = '';
    Array.from(form.elements).forEach((el) => { el.disabled = true; });
    $('#btn-password-close').disabled = true;
    try {
      await API.changePassword({ oldPassword, newPassword });
      clearLocalSession();
      toast('密码已修改，请重新登录');
    } catch (err) { error.textContent = employeeError(err); }
    finally {
      passwordSaving = false;
      Array.from(form.elements).forEach((el) => { el.disabled = false; });
      $('#btn-password-close').disabled = false;
    }
  });
}
