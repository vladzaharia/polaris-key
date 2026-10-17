"""The refusal copy of the five backend codes, by locale (WIRE-CONTRACT-V4 §14.3).

Kept equal to ``conformance/parity/copy.<locale>.json`` by ``tests/test_server_copy.py``; the
wheel cannot read the monorepo, so the five codes' title and message are carried here.
"""

from __future__ import annotations

from typing import Mapping

#: locale -> code -> (title, message)
COPY: Mapping[str, Mapping[str, tuple]] = {
    'en': {
        'license_required': ('License needed', 'Activate the app, then try again.'),
        'license_invalid': ('License not accepted', "Your license couldn't be verified. Reconnect the app, then try again."),
        'license_stale': ('License needs refreshing', 'Connect to the internet so the app can refresh your license, then try again.'),
        'not_entitled': ('Not included', "Your license doesn't include this."),
        'sign_in_required': ('Sign-in needed', 'Sign in to your Polaris Key account in the app, then try again.'),
    },
    'de': {
        'license_required': ('Lizenz erforderlich', 'Aktivieren Sie die App und versuchen Sie es dann erneut.'),
        'license_invalid': ('Lizenz nicht akzeptiert', 'Ihre Lizenz konnte nicht verifiziert werden. Stellen Sie die Verbindung der App wieder her und versuchen Sie es dann erneut.'),
        'license_stale': ('Lizenz muss aktualisiert werden', 'Stellen Sie eine Internetverbindung her, damit die App Ihre Lizenz aktualisieren kann, und versuchen Sie es dann erneut.'),
        'not_entitled': ('Nicht enthalten', 'Ihre Lizenz umfasst dies nicht.'),
        'sign_in_required': ('Anmeldung erforderlich', 'Melden Sie sich in der App bei Ihrem Polaris Key-Konto an und versuchen Sie es dann erneut.'),
    },
    'es': {
        'license_required': ('Se necesita una licencia', 'Activa la app y vuelve a intentarlo.'),
        'license_invalid': ('Licencia no aceptada', 'No se pudo verificar tu licencia. Reconecta la app y vuelve a intentarlo.'),
        'license_stale': ('Hay que actualizar la licencia', 'Conéctate a internet para que la app pueda actualizar tu licencia y vuelve a intentarlo.'),
        'not_entitled': ('No incluido', 'Tu licencia no incluye esto.'),
        'sign_in_required': ('Es necesario iniciar sesión', 'Inicia sesión en tu cuenta de Polaris Key en la app y vuelve a intentarlo.'),
    },
    'it': {
        'license_required': ('Licenza necessaria', "Attiva l'app, poi riprova."),
        'license_invalid': ('Licenza non accettata', "Impossibile verificare la tua licenza. Ricollega l'app, poi riprova."),
        'license_stale': ('Licenza da aggiornare', "Connettiti a internet per consentire all'app di aggiornare la tua licenza, poi riprova."),
        'not_entitled': ('Non incluso', 'La tua licenza non include questa funzione.'),
        'sign_in_required': ('Accesso richiesto', "Accedi al tuo account Polaris Key nell'app, poi riprova."),
    },
    'ja': {
        'license_required': ('ライセンスが必要です', 'アプリをアクティベートしてから、もう一度お試しください。'),
        'license_invalid': ('ライセンスを受け付けられません', 'ライセンスを確認できませんでした。アプリを再接続してから、もう一度お試しください。'),
        'license_stale': ('ライセンスの更新が必要です', 'アプリがライセンスを更新できるようにインターネットに接続してから、もう一度お試しください。'),
        'not_entitled': ('含まれていません', 'お持ちのライセンスにはこれが含まれていません。'),
        'sign_in_required': ('サインインが必要です', 'アプリでPolaris Keyアカウントにサインインしてから、もう一度お試しください。'),
    },
    'ko': {
        'license_required': ('라이선스 필요', '앱을 활성화한 후 다시 시도하세요.'),
        'license_invalid': ('라이선스를 확인할 수 없음', '라이선스를 확인하지 못했어요. 앱을 다시 연결한 후 다시 시도하세요.'),
        'license_stale': ('라이선스 새로 고침 필요', '앱이 라이선스를 새로 고칠 수 있도록 인터넷에 연결한 후 다시 시도하세요.'),
        'not_entitled': ('포함되지 않음', '라이선스에 포함되지 않은 항목이에요.'),
        'sign_in_required': ('로그인 필요', '앱에서 Polaris Key 계정에 로그인한 후 다시 시도하세요.'),
    },
    'pt-BR': {
        'license_required': ('Licença necessária', 'Ative o app e tente novamente.'),
        'license_invalid': ('Licença não aceita', 'Não foi possível verificar sua licença. Reconecte o app e tente novamente.'),
        'license_stale': ('A licença precisa ser atualizada', 'Conecte-se à internet para que o app possa atualizar sua licença e tente novamente.'),
        'not_entitled': ('Não incluído', 'Sua licença não inclui isso.'),
        'sign_in_required': ('É preciso entrar', 'Entre na sua conta do Polaris Key no app e tente novamente.'),
    },
    'zh-Hans': {
        'license_required': ('需要许可证', '请激活应用，然后重试。'),
        'license_invalid': ('许可证未被接受', '无法验证你的许可证。请重新连接应用，然后重试。'),
        'license_stale': ('许可证需要刷新', '请连接互联网，以便应用刷新你的许可证，然后重试。'),
        'not_entitled': ('未包含', '你的许可证不包含此内容。'),
        'sign_in_required': ('需要登录', '请在应用中登录你的Polaris Key账户，然后重试。'),
    },
}
