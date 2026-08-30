import { signIn } from "./auth.js";
import { escapeHtml } from "./app.js";

export function render(container) {
  container.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-card__brand">
          <span class="sidebar__brand-mark" style="background: var(--accent);">EC</span>
          <span class="login-card__brand-name">ERPConnect</span>
        </div>
        <p class="login-card__hint">Entre com seu usuário e senha para continuar.</p>
        <form id="login-form">
          <div id="login-error"></div>
          <div class="field">
            <label for="login-user">Usuário</label>
            <input class="input" type="text" id="login-user" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required />
          </div>
          <div class="field">
            <label for="login-pass">Senha</label>
            <input class="input" type="password" id="login-pass" autocomplete="current-password" required />
          </div>
          <button type="submit" class="btn btn--primary" id="login-submit" style="width:100%; justify-content:center; margin-top: 0.5rem;">Entrar</button>
        </form>
      </div>
    </div>
  `;

  const form = container.querySelector("#login-form");
  const errorEl = container.querySelector("#login-error");
  const submitBtn = container.querySelector("#login-submit");
  const userInput = container.querySelector("#login-user");
  const passInput = container.querySelector("#login-pass");

  userInput.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.innerHTML = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Entrando…";

    try {
      // Ao logar com sucesso, o listener de auth registrado em app.js
      // percebe a mudança de sessão e re-renderiza a rota atual sozinho.
      await signIn(userInput.value, passInput.value);
    } catch (err) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
      submitBtn.disabled = false;
      submitBtn.textContent = "Entrar";
    }
  });
}
