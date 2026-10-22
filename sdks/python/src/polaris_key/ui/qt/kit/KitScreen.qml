import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import ".."

// One kit screen, drawn from the bridge's `spec` (polaris_key.ui.qt.layout.ScreenSpec): the product
// as the hero, a heading, sentences, at most one filled action. Responsive on the root's width and
// height (DL1): below 520 logical px the card is the window; above, a centred column.
Rectangle {
    id: root
    // The Python bridge (polaris_key.ui.qt.bridge.KitBridge), set as a context property.
    readonly property QtObject kit: bridge
    readonly property var spec: kit.spec
    readonly property real fs: kit.fontScale
    readonly property bool compact: width < 520
    readonly property real gutter: (compact ? 16 : 32) * Theme.densityScale

    color: Theme.surfacePage
    Accessible.role: Accessible.Pane
    Accessible.name: spec.title || spec.product

    Binding { target: Theme; property: "scheme"; value: kit.scheme }
    Binding { target: Theme; property: "platform"; value: kit.platform }
    // The theme options (UI-KITS 3.1), as the bridge resolved them for this host.
    Binding { target: Theme; property: "colorOverrides"; value: kit.colorOverrides }
    Binding { target: Theme; property: "density"; value: kit.density }
    Binding { target: Theme; property: "radiusScale"; value: kit.radiusScale }
    Binding { target: Theme; property: "surfaceScale"; value: kit.surfaceScale }
    Binding { target: Theme; property: "radiusPx"; value: kit.radiusPx }
    Binding { target: Theme; property: "fontFamily"; value: kit.fontFamily; when: kit.fontFamily !== "" }
    Binding { target: Theme; property: "monoFamily"; value: kit.monoFamily; when: kit.monoFamily !== "" }
    Binding { target: Theme; property: "displayFamily"; value: kit.displayFamily }
    Binding { target: Theme; property: "accent"; value: kit.accent; when: kit.accent !== "" }
    Binding { target: Theme; property: "accentOn"; value: kit.accentOn; when: kit.accent !== "" }
    Binding { target: Theme; property: "accentFg"; value: kit.accentFg; when: kit.accent !== "" }
    Binding { target: Theme; property: "accentSubtle"; value: kit.accentSubtle; when: kit.accent !== "" }
    Binding { target: Theme; property: "focusRing"; value: kit.focusRing; when: kit.accent !== "" }

    // The product ambient (UI-KITS 1.2): the accent's tint as two soft glows behind the card. None
    // under `native`, with `ambient: false`, or while the product has no accent.
    Image {
        objectName: "ambient"
        anchors.fill: parent
        visible: kit.ambientSource !== ""
        source: kit.ambientSource
        fillMode: Image.Stretch
        smooth: true
        Accessible.ignored: true
    }

    Flickable {
        id: scroller
        anchors.fill: parent
        contentWidth: width
        contentHeight: Math.max(height, card.height + 2 * root.gutter)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Rectangle {
            id: card
            objectName: "card"
            // DL7: a load shows nothing for its first 250 ms (the bridge's clock), then the identity,
            // a muted label and the 2 px shimmer.
            visible: !spec.hidden && (!spec.loading || kit.loadingShown)
            width: Math.min(scroller.width - 2 * root.gutter, 480)
            x: (scroller.width - width) / 2
            y: Math.max(root.gutter, (scroller.height - height) / 2)
            height: column.implicitHeight + 2 * Theme.cardPad
            radius: Theme.radiusSurface
            color: Theme.surfaceRaised
            border.width: 1
            border.color: Theme.borderSubtle

            ColumnLayout {
                id: column
                x: Theme.cardPad
                y: Theme.cardPad
                width: card.width - 2 * Theme.cardPad
                spacing: 12 * Theme.densityScale

                // The product header (UI-KITS 1.2, DL5): its icon, or a monogram tile of its initial,
                // at 32 px beside the name; the hero size on Welcome, whose title names the product.
                RowLayout {
                    id: identity
                    visible: spec.product !== ""
                    readonly property real side: (spec.hero ? 64 : 32) * root.fs
                    spacing: 10
                    Image {
                        id: icon
                        objectName: "icon"
                        visible: status === Image.Ready
                        source: kit.iconSource
                        sourceSize.width: 2 * identity.side
                        sourceSize.height: 2 * identity.side
                        Layout.preferredWidth: identity.side
                        Layout.preferredHeight: identity.side
                        fillMode: Image.PreserveAspectFit
                        Accessible.role: Accessible.Graphic
                        Accessible.name: kit.iconLabel
                    }
                    Rectangle {
                        id: monogram
                        objectName: "monogram"
                        visible: icon.status !== Image.Ready && kit.monogram !== ""
                        Layout.preferredWidth: identity.side
                        Layout.preferredHeight: identity.side
                        radius: width * 0.22
                        color: Theme.surfaceSunken
                        border.width: 1
                        border.color: Theme.borderSubtle
                        Accessible.role: Accessible.Graphic
                        Accessible.name: kit.iconLabel
                        Text {
                            anchors.centerIn: parent
                            text: kit.monogram
                            font.family: Theme.fontFamily
                            font.pixelSize: identity.side * 0.5
                            font.weight: Theme.weightSemibold
                            color: Theme.textStrong
                            Accessible.ignored: true
                        }
                    }
                    ColumnLayout {
                        spacing: 0
                        Text {
                            objectName: "productName"
                            text: spec.product
                            visible: spec.showName
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeLabel.size * root.fs
                            font.weight: Theme.weightMedium
                            color: Theme.textStrong
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                        Text {
                            text: spec.developerLine
                            visible: text !== ""
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeMeta.size * root.fs
                            color: Theme.textSubtle
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                    }
                }

                Text {
                    id: heading
                    visible: text !== ""
                    text: spec.title
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    font.family: Theme.displayFamily !== "" ? Theme.displayFamily : Theme.fontFamily
                    font.pixelSize: Theme.typeTitle.size * root.fs
                    font.weight: Theme.typeTitle.weight
                    color: spec.titleTone === "danger" ? Theme.danger : Theme.textStrong
                    // The heading takes focus when a state has no field (DL9), so a reader lands on it.
                    focus: spec.focus === "heading"
                    activeFocusOnTab: true
                    Accessible.role: Accessible.Heading
                    Accessible.name: text
                }

                // OfflineActivation's two numbered steps, the request QR under the first.
                Repeater {
                    model: spec.steps
                    KitStep {
                        required property var modelData
                        step: modelData
                        fs: root.fs
                        Layout.fillWidth: true
                    }
                }

                Repeater {
                    model: spec.body
                    Text {
                        required property string modelData
                        text: modelData
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.typeBody.size * root.fs
                        lineHeight: Theme.typeBody.lineHeight * root.fs
                        lineHeightMode: Text.FixedHeight
                        color: spec.loading ? Theme.textMuted : Theme.textDefault
                        Accessible.role: Accessible.StaticText
                        Accessible.name: modelData
                    }
                }

                // The device code (UI-KITS 4.3): the code in mono with Copy, the countdown, a QR only where DL14 allows.
                KitCode {
                    objectName: "code"
                    visible: !!spec.code
                    code: spec.code
                    fs: root.fs
                    kit: root.kit
                    Layout.fillWidth: true
                }

                // The seat meter (rule 9), under the lede and above the list.
                KitSeatMeter {
                    objectName: "seatMeter"
                    visible: !!spec.seat
                    seat: spec.seat
                    fs: root.fs
                    Layout.fillWidth: true
                }

                TextField {
                    id: searchField
                    objectName: "search"
                    visible: spec.search !== ""
                    Layout.fillWidth: true
                    placeholderText: spec.search
                    placeholderTextColor: Theme.textSubtle
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.typeBody.size * root.fs
                    color: Theme.textStrong
                    activeFocusOnTab: true
                    implicitHeight: Math.max(Theme.controlHeight * root.fs, 36 * Math.min(1, Theme.densityScale))
                    onTextEdited: kit.edit("search", text)
                    Accessible.role: Accessible.EditableText
                    Accessible.name: spec.search
                    background: Rectangle {
                        radius: Theme.radiusControl < 0 ? height / 2 : Theme.radiusControl
                        color: Theme.surfaceSunken
                        border.width: searchField.activeFocus ? 2 : 1
                        border.color: searchField.activeFocus ? Theme.focusRing : Theme.borderSubtle
                    }
                }

                // Grouped rows: settings, devices, the account (UI-KITS 4.1, 4.3).
                Repeater {
                    model: spec.groups
                    KitGroup {
                        required property var modelData
                        group: modelData
                        fs: root.fs
                        kit: root.kit
                        Layout.fillWidth: true
                    }
                }

                // The sentences that follow a list: the Replace confirm, its first line bold.
                Repeater {
                    model: spec.after
                    Text {
                        required property var modelData
                        text: modelData.text
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.typeBody.size * root.fs
                        font.weight: modelData.strong ? Theme.weightSemibold : Theme.weightRegular
                        color: modelData.strong ? Theme.textStrong : Theme.textDefault
                        Accessible.role: Accessible.StaticText
                        Accessible.name: modelData.text
                    }
                }

                // DL7: a text entry, its hint or its error directly under it. Only an input that is
                // itself wrong takes the danger stroke; the message is read with the field.
                Repeater {
                    model: spec.fields
                    ColumnLayout {
                        id: fieldBox
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: 6
                        Text {
                            text: fieldBox.modelData.label
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeLabel.size * root.fs
                            font.weight: Theme.weightMedium
                            color: Theme.textStrong
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 8 * Theme.densityScale
                            TextField {
                                id: entry
                                objectName: "entry"
                                Layout.fillWidth: true
                                text: fieldBox.modelData.value
                                placeholderText: fieldBox.modelData.placeholder
                                placeholderTextColor: Theme.textSubtle
                                font.family: Theme.monoFamily
                                font.pixelSize: Theme.typeBody.size * root.fs
                                color: Theme.textStrong
                                focus: spec.focus === fieldBox.modelData.key
                                activeFocusOnTab: true
                                selectByMouse: true
                                // A key is a secret: no suggestions, no stored predictions, no capital to start.
                                inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
                                implicitHeight: Math.max(Theme.controlHeight * root.fs, 36 * Math.min(1, Theme.densityScale))
                                onTextEdited: kit.edit(fieldBox.modelData.key, text)
                                // Enter does what the screen's one filled button does.
                                onAccepted: if (spec.primaryKey !== "") kit.invoke(spec.primaryKey, "")
                                Component.onCompleted: cursorPosition = length
                                Accessible.role: Accessible.EditableText
                                Accessible.name: fieldBox.modelData.label
                                Accessible.description: fieldBox.modelData.error || fieldBox.modelData.hint
                                background: Rectangle {
                                    radius: Theme.radiusControl < 0 ? height / 2 : Theme.radiusControl
                                    color: Theme.surfaceSunken
                                    border.width: entry.activeFocus || fieldBox.modelData.error !== "" ? 2 : 1
                                    border.color: fieldBox.modelData.error !== "" ? Theme.danger
                                                : entry.activeFocus ? Theme.focusRing : Theme.borderSubtle
                                }
                            }
                            // Paste, at the end of the field: the key is in the clipboard from the purchase email.
                            KitButton {
                                objectName: "paste"
                                visible: fieldBox.modelData.paste !== ""
                                text: fieldBox.modelData.paste
                                role: "secondary"
                                scale_: root.fs
                                onClicked: kit.invoke("common.paste", "paste")
                            }
                        }
                        Text {
                            visible: text !== ""
                            text: fieldBox.modelData.error !== "" ? fieldBox.modelData.error : fieldBox.modelData.hint
                            Layout.fillWidth: true
                            wrapMode: Text.WordWrap
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeMeta.size * root.fs
                            color: fieldBox.modelData.error !== "" ? Theme.danger : Theme.textMuted
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                    }
                }

                // DL6: a refusal the person can resolve reads as a plain callout (default text on the sunken
                // surface, no danger colour, no error glyph); its fix is the screen's one filled button.
                Repeater {
                    model: spec.callout
                    Rectangle {
                        id: callout
                        required property string modelData
                        objectName: "callout"
                        Layout.fillWidth: true
                        implicitHeight: calloutText.implicitHeight + 24
                        radius: Theme.radiusControl < 0 ? 12 : Math.max(Theme.radiusControl, 6)
                        color: Theme.surfaceSunken
                        border.width: 1
                        border.color: Theme.borderSubtle
                        Accessible.role: Accessible.AlertMessage
                        Accessible.name: modelData
                        Text {
                            id: calloutText
                            anchors.fill: parent
                            anchors.margins: 12
                            text: callout.modelData
                            wrapMode: Text.WordWrap
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeBody.size * root.fs
                            color: Theme.textDefault
                            Accessible.ignored: true
                        }
                    }
                }

                // DL7: the 2 px shimmer for a wait with no count (text-strong at low alpha, never a
                // part-filled bar); under reduced motion it holds still.
                Item {
                    id: shimmer
                    objectName: "shimmer"
                    visible: spec.progress > -2 && spec.progress < 0
                    Layout.fillWidth: true
                    implicitHeight: 2
                    clip: true
                    Accessible.role: Accessible.ProgressBar
                    Accessible.name: spec.title || spec.product
                    Rectangle {
                        anchors.fill: parent
                        color: Theme.textStrong
                        opacity: 0.12
                    }
                    Rectangle {
                        id: sweep
                        width: shimmer.width * 0.3
                        height: shimmer.height
                        color: Theme.textStrong
                        opacity: 0.4
                        SequentialAnimation on x {
                            running: kit.animate && shimmer.visible
                            loops: Animation.Infinite
                            NumberAnimation { from: 0; to: 0.7 * shimmer.width; duration: 1200; easing.type: Easing.InOutQuad }
                            NumberAnimation { from: 0.7 * shimmer.width; to: 0; duration: 1200; easing.type: Easing.InOutQuad }
                        }
                    }
                }

                // A determinate bar only for counted bytes (DL7).
                ProgressBar {
                    id: bar
                    objectName: "bar"
                    visible: spec.progress >= 0
                    Layout.fillWidth: true
                    value: Math.max(0, spec.progress)
                    Accessible.name: spec.title || spec.product
                    background: Rectangle { implicitHeight: 4; radius: 2; color: Theme.surfaceSunken }
                    contentItem: Item {
                        id: track
                        implicitHeight: 4
                        Rectangle {
                            width: track.width * bar.visualPosition
                            height: track.height
                            radius: 2
                            color: Theme.accent
                        }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 8 * Theme.densityScale
                    spacing: 8 * Theme.densityScale
                    visible: spec.buttons.length > 0
                    Repeater {
                        model: spec.buttons.filter(b => b.role !== "quiet")
                        KitButton {
                            required property var modelData
                            text: modelData.text
                            role: modelData.role
                            scale_: root.fs
                            busy: modelData.busy
                            animate: kit.animate
                            Layout.fillWidth: true
                            onClicked: if (!modelData.busy) kit.invoke(modelData.key, modelData.action)
                        }
                    }
                    Flow {
                        Layout.fillWidth: true
                        spacing: 12
                        Repeater {
                            model: spec.buttons.filter(b => b.role === "quiet")
                            KitButton {
                                required property var modelData
                                text: modelData.text
                                role: "quiet"
                                scale_: root.fs
                                onClicked: kit.invoke(modelData.key, modelData.action)
                            }
                        }
                    }
                }

                // UI-KITS §1.6: the Locker micro mark (16) and the phrase; with poweredBy "badge",
                // the 320 x 104 badge where 320 px is free, else the line.
                Image {
                    id: poweredBadge
                    readonly property bool shown: spec.poweredBy === "badge" && spec.component === "About" && column.width >= 320
                    visible: shown
                    Layout.alignment: Qt.AlignHCenter
                    Layout.topMargin: 8
                    Layout.preferredWidth: shown ? 320 : 0
                    Layout.preferredHeight: shown ? 104 : 0
                    sourceSize.width: 640
                    sourceSize.height: 208
                    source: shown ? kit.poweredByBadge : ""
                    Accessible.role: Accessible.Graphic
                    Accessible.name: spec.poweredByText
                }
                RowLayout {
                    visible: spec.poweredBy !== "" && !poweredBadge.shown
                    Layout.alignment: Qt.AlignHCenter
                    Layout.topMargin: 8
                    spacing: 8
                    Image {
                        // 16 px floor, growing with the text (UI-KITS 1.6).
                        readonly property real side: Math.max(16, Theme.typeMeta.size * root.fs * 1.25)
                        Layout.preferredWidth: side
                        Layout.preferredHeight: side
                        sourceSize.width: side * 2
                        sourceSize.height: side * 2
                        source: kit.poweredByMark
                        Accessible.ignored: true
                    }
                    Text {
                        text: spec.poweredByText
                        wrapMode: Text.Wrap
                        Layout.maximumWidth: column.width - 40
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.typeMeta.size * root.fs
                        color: Theme.textSubtle
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                }
            }
        }
    }
}
