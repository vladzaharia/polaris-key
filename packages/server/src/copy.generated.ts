// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen constants` (tools/gen-sdk-constants.ts) from conformance/parity/
// copy.<locale>.json. `pnpm gen constants --check` fails the green gate on any difference. To
// change a string, edit the copy file and regenerate.
//
// WIRE-CONTRACT-V4 §14.3: a refusal's title and detail, per locale, for the five backend codes.

import type {
  BackendCopyTable,
  BackendLocale,
} from "@polaris-key/client-core/backend";

export const BACKEND_COPY: Readonly<Record<BackendLocale, BackendCopyTable>> = {
  en: {
    license_required: {
      title: "License needed",
      message: "Activate the app, then try again.",
    },
    license_invalid: {
      title: "License not accepted",
      message:
        "Your license couldn't be verified. Reconnect the app, then try again.",
    },
    license_stale: {
      title: "License needs refreshing",
      message:
        "Connect to the internet so the app can refresh your license, then try again.",
    },
    not_entitled: {
      title: "Not included",
      message: "Your license doesn't include this.",
    },
    sign_in_required: {
      title: "Sign-in needed",
      message:
        "Sign in to your Polaris Locker account in the app, then try again.",
    },
  },
  de: {
    license_required: {
      title: "Lizenz erforderlich",
      message: "Aktivieren Sie die App und versuchen Sie es dann erneut.",
    },
    license_invalid: {
      title: "Lizenz nicht akzeptiert",
      message:
        "Ihre Lizenz konnte nicht verifiziert werden. Stellen Sie die Verbindung der App wieder her und versuchen Sie es dann erneut.",
    },
    license_stale: {
      title: "Lizenz muss aktualisiert werden",
      message:
        "Stellen Sie eine Internetverbindung her, damit die App Ihre Lizenz aktualisieren kann, und versuchen Sie es dann erneut.",
    },
    not_entitled: {
      title: "Nicht enthalten",
      message: "Ihre Lizenz umfasst dies nicht.",
    },
    sign_in_required: {
      title: "Anmeldung erforderlich",
      message:
        "Melden Sie sich in der App bei Ihrem Polaris Locker-Konto an und versuchen Sie es dann erneut.",
    },
  },
  es: {
    license_required: {
      title: "Se necesita una licencia",
      message: "Activa la app y vuelve a intentarlo.",
    },
    license_invalid: {
      title: "Licencia no aceptada",
      message:
        "No se pudo verificar tu licencia. Reconecta la app y vuelve a intentarlo.",
    },
    license_stale: {
      title: "Hay que actualizar la licencia",
      message:
        "Conéctate a internet para que la app pueda actualizar tu licencia y vuelve a intentarlo.",
    },
    not_entitled: {
      title: "No incluido",
      message: "Tu licencia no incluye esto.",
    },
    sign_in_required: {
      title: "Es necesario iniciar sesión",
      message:
        "Inicia sesión en tu cuenta de Polaris Locker en la app y vuelve a intentarlo.",
    },
  },
  fr: {
    license_required: {
      title: "Licence requise",
      message: "Activez l’app, puis réessayez.",
    },
    license_invalid: {
      title: "Licence non acceptée",
      message:
        "Votre licence n’a pas pu être vérifiée. Reconnectez l’app, puis réessayez.",
    },
    license_stale: {
      title: "Licence à actualiser",
      message:
        "Connectez-vous à Internet pour que l’app puisse actualiser votre licence, puis réessayez.",
    },
    not_entitled: {
      title: "Non inclus",
      message: "Votre licence n’inclut pas cet élément.",
    },
    sign_in_required: {
      title: "Connexion nécessaire",
      message:
        "Connectez-vous à votre compte Polaris Locker dans l’app, puis réessayez.",
    },
  },
  it: {
    license_required: {
      title: "Licenza necessaria",
      message: "Attiva l'app, poi riprova.",
    },
    license_invalid: {
      title: "Licenza non accettata",
      message:
        "Impossibile verificare la tua licenza. Ricollega l'app, poi riprova.",
    },
    license_stale: {
      title: "Licenza da aggiornare",
      message:
        "Connettiti a internet per consentire all'app di aggiornare la tua licenza, poi riprova.",
    },
    not_entitled: {
      title: "Non incluso",
      message: "La tua licenza non include questa funzione.",
    },
    sign_in_required: {
      title: "Accesso richiesto",
      message: "Accedi al tuo account Polaris Locker nell'app, poi riprova.",
    },
  },
  ja: {
    license_required: {
      title: "ライセンスが必要です",
      message: "アプリをアクティベートしてから、もう一度お試しください。",
    },
    license_invalid: {
      title: "ライセンスを受け付けられません",
      message:
        "ライセンスを確認できませんでした。アプリを再接続してから、もう一度お試しください。",
    },
    license_stale: {
      title: "ライセンスの更新が必要です",
      message:
        "アプリがライセンスを更新できるようにインターネットに接続してから、もう一度お試しください。",
    },
    not_entitled: {
      title: "含まれていません",
      message: "お持ちのライセンスにはこれが含まれていません。",
    },
    sign_in_required: {
      title: "サインインが必要です",
      message:
        "アプリでPolaris Lockerアカウントにサインインしてから、もう一度お試しください。",
    },
  },
  ko: {
    license_required: {
      title: "라이선스 필요",
      message: "앱을 활성화한 후 다시 시도하세요.",
    },
    license_invalid: {
      title: "라이선스를 확인할 수 없음",
      message:
        "라이선스를 확인하지 못했어요. 앱을 다시 연결한 후 다시 시도하세요.",
    },
    license_stale: {
      title: "라이선스 새로 고침 필요",
      message:
        "앱이 라이선스를 새로 고칠 수 있도록 인터넷에 연결한 후 다시 시도하세요.",
    },
    not_entitled: {
      title: "포함되지 않음",
      message: "라이선스에 포함되지 않은 항목이에요.",
    },
    sign_in_required: {
      title: "로그인 필요",
      message: "앱에서 Polaris Locker 계정에 로그인한 후 다시 시도하세요.",
    },
  },
  "pt-BR": {
    license_required: {
      title: "Licença necessária",
      message: "Ative o app e tente novamente.",
    },
    license_invalid: {
      title: "Licença não aceita",
      message:
        "Não foi possível verificar sua licença. Reconecte o app e tente novamente.",
    },
    license_stale: {
      title: "A licença precisa ser atualizada",
      message:
        "Conecte-se à internet para que o app possa atualizar sua licença e tente novamente.",
    },
    not_entitled: {
      title: "Não incluído",
      message: "Sua licença não inclui isso.",
    },
    sign_in_required: {
      title: "É preciso entrar",
      message: "Entre na sua conta do Polaris Locker no app e tente novamente.",
    },
  },
  "zh-Hans": {
    license_required: {
      title: "需要许可证",
      message: "请激活应用，然后重试。",
    },
    license_invalid: {
      title: "许可证未被接受",
      message: "无法验证你的许可证。请重新连接应用，然后重试。",
    },
    license_stale: {
      title: "许可证需要刷新",
      message: "请连接互联网，以便应用刷新你的许可证，然后重试。",
    },
    not_entitled: { title: "未包含", message: "你的许可证不包含此内容。" },
    sign_in_required: {
      title: "需要登录",
      message: "请在应用中登录你的Polaris Locker账户，然后重试。",
    },
  },
};
