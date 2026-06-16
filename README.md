# POC Automatizacion MCE QA con Playwright

Este proyecto valida la viabilidad de automatizar pruebas funcionales y de concurrencia para el sistema de subastas MCE.

## Alcance actual

- Carga usuarios desde CSV por rol (buyer/seller).
- Valida la pantalla de login para comprador y vendedor.
- Simula sesiones concurrentes en paralelo hasta el paso de captcha.
- Genera reporte HTML de Playwright.

## Limitacion actual

Con el reCAPTCHA activo, no es viable automatizar de forma deterministica el login completo (bloquea la entrada al sistema). Por ahora, el POC deja validado el flujo hasta ese punto.

Cuando el captcha sea desactivado en QA, se puede extender para:

- Login completo.
- Flujo de comprador para colocar posturas.
- Flujo de vendedor para publicar ventas.
- Pruebas de concurrencia con multiples cuentas por rol.

## Estructura

- `data/users.csv`: usuarios de acceso por rol.
- `src/csvUsers.ts`: lector y filtro de usuarios activos.
- `tests/auth-login.spec.ts`: prueba base de login por rol.
- `tests/concurrency.spec.ts`: prueba POC de concurrencia.
- `playwright.config.ts`: configuracion general.

## Ejecucion

```bash
npm install
npx playwright install chromium
npm run test:login
npm run test:concurrency
npm test
npm run report
```

## Formato CSV

```csv
role,company,profile,username,password,active
buyer,FhanorA,Negociador,usuario@correo.com,Password,true
seller,FhanorB,Negociador,usuario@correo.com,Password,true
```
