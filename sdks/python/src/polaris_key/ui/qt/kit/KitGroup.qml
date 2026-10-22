import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import ".."

// One inset grouped list (UI-KITS 4.1, 4.3): a 13 px heading, then rows in a radius-16 surface with
// hairlines inset past the glyph. Device rows are 64 px with a bare 20 px form-factor glyph; other rows
// are at least 52 px. Real controls: a Switch, Slider, ComboBox, TextField, RadioButton and Buttons, in
// DOM (tab) order, each with an accessible name. Everything it shows arrives in `group` (rows.py).
ColumnLayout {
    id: groupRoot
    property var group
    property real fs: 1
    // The bridge: invokeRow(key, action, row), edit(key, text), select(row).
    property QtObject kit
    spacing: 8

    // The buttons of one row: real buttons, each named for its row ("Rename Work laptop").
    component RowButtons: Flow {
        id: buttons
        property var row
        // A row of nothing but buttons draws them as buttons (outlined), not as bare text.
        property bool solo: false
        spacing: 8
        Repeater {
            model: buttons.row.actions
            KitButton {
                required property var modelData
                text: modelData.text
                role: buttons.solo && modelData.role === "quiet" ? "secondary" : modelData.role
                scale_: groupRoot.fs
                Accessible.name: modelData.name
                Accessible.description: modelData.describe
                onClicked: groupRoot.kit.invoke_row(modelData.key, modelData.action, buttons.row.id)
            }
        }
    }

    Text {
        visible: text !== ""
        text: groupRoot.group.heading
        font.family: Theme.fontFamily
        font.pixelSize: Math.max(13, Theme.typeMeta.size) * groupRoot.fs
        font.weight: Theme.weightMedium
        color: Theme.textMuted
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        Accessible.role: Accessible.Heading
        Accessible.name: text
    }

    Rectangle {
        id: surface
        objectName: "group"
        Layout.fillWidth: true
        implicitHeight: list.implicitHeight
        radius: 16
        color: Theme.surfaceOverlay
        border.width: 1
        border.color: Theme.borderSubtle
        clip: true
        Accessible.role: groupRoot.group.radio ? Accessible.RadioButton : Accessible.List
        Accessible.name: groupRoot.group.heading

        ColumnLayout {
            id: list
            width: parent.width
            spacing: 0
            Repeater {
                model: groupRoot.group.rows
                delegate: Item {
                    id: rowItem
                    required property var modelData
                    required property int index
                    readonly property var r: modelData
                    readonly property bool device: r.glyph !== ""
                    // A row with no words of its own is a button row, start-aligned (UI-KITS 4.1).
                    readonly property bool lone: r.actions.length > 0 && r.title === "" && r.meta === ""
                        && r.control === "" && r.value === "" && r.text === "" && !r.seat && !r.radio
                    // Actions under the text (React: `@container pk (max-width: 30rem)`): confirm and rename
                    // rows always, and any row whose text and buttons do not fit on one line. The text is
                    // never squeezed, so no single word is left alone on a line.
                    readonly property real wordsWidth: Math.max(titleText.implicitWidth + (r.tag !== "" ? 8 + tagPill.implicitWidth : 0), metaText.visible ? metaText.implicitWidth : 0)
                    readonly property bool fitsInline: wordsWidth + (glyphItem.visible ? glyphItem.width + body.columnSpacing : 0)
                        + body.columnSpacing + measure.implicitWidth <= body.width
                    readonly property bool stacked: r.actions.length > 0 && !lone
                        && (r.kind === "confirm" || r.kind === "edit" || !fitsInline)
                    Layout.fillWidth: true
                    objectName: "row-" + r.id
                    implicitHeight: Math.max((device ? 64 : 52) * groupRoot.fs, body.implicitHeight + 20)

                    // The hairline, inset past the glyph (logical start side), not on the first row.
                    Rectangle {
                        visible: rowItem.index > 0
                        x: rowItem.device ? 52 : 16
                        width: parent.width - x
                        height: 1
                        color: Theme.borderSubtle
                    }
                    Rectangle {
                        anchors.fill: parent
                        visible: r.selected
                        color: Theme.accentSubtle
                    }

                    GridLayout {
                        id: body
                        x: 16
                        width: parent.width - 32
                        anchors.verticalCenter: parent.verticalCenter
                        // A confirm, a rename or a narrow row stacks its buttons under the words (the text
                        // column carries them); the rest is one line.
                        columns: 12
                        columnSpacing: 12
                        rowSpacing: 8

                        KitGlyph {
                            id: glyphItem
                            visible: rowItem.device && r.kind !== "edit"
                            name: r.glyph
                            size: 20 * groupRoot.fs
                            color: Theme.textMuted
                            Layout.alignment: Qt.AlignTop | Qt.AlignVCenter
                            Accessible.role: Accessible.Graphic
                            Accessible.name: r.glyphLabel
                        }

                        ColumnLayout {
                            visible: !rowItem.lone
                            Layout.fillWidth: true
                            spacing: 2
                            // The device name and its tag ("Least recent") share a line.
                            RowLayout {
                                visible: r.title !== "" && r.kind !== "edit"
                                spacing: 8
                                Text {
                                    id: titleText
                                    text: r.title
                                    Layout.fillWidth: true
                                    Layout.maximumWidth: body.width
                                    elide: Text.ElideRight
                                    maximumLineCount: 1
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.typeBody.size * groupRoot.fs
                                    font.weight: Theme.weightRegular
                                    color: Theme.textStrong
                                    Accessible.ignored: true
                                }
                                Rectangle {
                                    id: tagPill
                                    visible: r.tag !== ""
                                    implicitWidth: tagText.implicitWidth + 16
                                    implicitHeight: tagText.implicitHeight + 4
                                    radius: height / 2
                                    color: Qt.alpha(Theme.textStrong, 0.09)
                                    Text {
                                        id: tagText
                                        anchors.centerIn: parent
                                        text: r.tag
                                        font.family: Theme.fontFamily
                                        font.pixelSize: 12 * groupRoot.fs
                                        font.weight: Theme.weightMedium
                                        color: Theme.textStrong
                                        Accessible.ignored: true
                                    }
                                }
                            }
                            Text {
                                id: metaText
                                visible: text !== ""
                                text: r.meta
                                Layout.fillWidth: true
                                wrapMode: Text.WordWrap
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.typeMeta.size * groupRoot.fs
                                color: Theme.textMuted
                                Accessible.ignored: true
                            }
                            Text {
                                visible: r.kind === "confirm"
                                text: r.text
                                Layout.fillWidth: true
                                wrapMode: Text.WordWrap
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.typeBody.size * groupRoot.fs
                                color: Theme.textDefault
                                Accessible.role: Accessible.StaticText
                                Accessible.name: text
                            }
                            // The inline rename (devices.renameLabel).
                            Text {
                                visible: r.kind === "edit"
                                text: r.fieldLabel
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.typeLabel.size * groupRoot.fs
                                font.weight: Theme.weightMedium
                                color: Theme.textStrong
                                Accessible.ignored: true
                            }
                            TextField {
                                id: rename
                                objectName: "rename"
                                visible: r.kind === "edit"
                                Layout.fillWidth: true
                                text: r.text
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.typeBody.size * groupRoot.fs
                                color: Theme.textStrong
                                selectByMouse: true
                                activeFocusOnTab: true
                                focus: r.kind === "edit"
                                onTextEdited: groupRoot.kit.edit(r.key, text)
                                onAccepted: groupRoot.kit.invoke_row("common.save", "save", r.id)
                                Accessible.role: Accessible.EditableText
                                Accessible.name: r.fieldLabel
                                background: Rectangle {
                                    radius: Theme.radiusControl < 0 ? height / 2 : Theme.radiusControl
                                    color: Theme.surfaceRaised
                                    border.width: rename.activeFocus ? 2 : 1
                                    border.color: rename.activeFocus ? Theme.focusRing : Theme.borderSubtle
                                }
                            }
                            // A license's seat meter (the tier pill with "n of limit devices").
                            KitSeatMeter {
                                visible: !!r.seat
                                seat: r.seat
                                fs: groupRoot.fs
                                Layout.fillWidth: true
                            }
                            Slider {
                                id: slider
                                padding: 0
                                objectName: "slider"
                                visible: r.control === "slider"
                                Layout.fillWidth: true
                                from: r.minimum
                                to: r.maximum
                                stepSize: r.step
                                value: r.number
                                snapMode: Slider.SnapAlways
                                activeFocusOnTab: true
                                onMoved: groupRoot.kit.edit(r.key, String(value))
                                Accessible.role: Accessible.Slider
                                Accessible.name: r.name
                                Accessible.description: r.value
                                background: Rectangle {
                                    y: slider.topPadding + slider.availableHeight / 2 - height / 2
                                    width: slider.availableWidth
                                    height: 4
                                    radius: 2
                                    color: Theme.borderSubtle
                                    Rectangle { width: slider.visualPosition * parent.width; height: 4; radius: 2; color: Theme.accent }
                                }
                                handle: Rectangle {
                                    x: slider.visualPosition * (slider.availableWidth - width)
                                    y: slider.topPadding + slider.availableHeight / 2 - height / 2
                                    width: 18
                                    height: 18
                                    radius: 9
                                    color: Theme.surfaceRaised
                                    border.width: slider.visualFocus ? 2 : 1
                                    border.color: slider.visualFocus ? Theme.focusRing : Theme.borderStrong
                                }
                            }
                            // Narrow, confirm and rename rows: the buttons under the words.
                            RowButtons {
                                objectName: "row-actions-stacked"
                                row: r
                                visible: rowItem.stacked
                                Layout.fillWidth: true
                                Layout.topMargin: 6
                                // A quiet button's text sits 4 px in: line it up with the words above.
                                Layout.leftMargin: r.actions[0].role === "quiet" ? -4 : 0
                            }
                        }

                        // Value, switch and choice, at the end of the line.
                        Text {
                            visible: (r.control === "slider" || r.control === "value" || (r.kind === "license" && r.value !== "")) && text !== ""
                            text: r.value
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeBody.size * groupRoot.fs
                            color: Theme.textMuted
                            Accessible.ignored: true
                        }
                        KitGlyph {
                            visible: r.locked && r.lockLabel !== ""
                            name: "lock"
                            size: 14 * groupRoot.fs
                            color: Theme.textMuted
                            Accessible.role: Accessible.Graphic
                            Accessible.name: r.lockLabel
                        }
                        Text {
                            visible: r.control === "switch" && r.stateText !== ""
                            text: r.stateText
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeMeta.size * groupRoot.fs
                            color: Theme.textMuted
                            Accessible.ignored: true
                        }
                        Switch {
                            id: toggle
                            objectName: "switch"
                            visible: r.control === "switch"
                            checked: r.on
                            implicitWidth: 44
                            implicitHeight: 24
                            padding: 0
                            activeFocusOnTab: true
                            // The model owns the value: the control reports the wish and the next view draws it.
                            onToggled: r.key === "advanced" ? groupRoot.kit.set_advanced(checked) : groupRoot.kit.edit(r.key, String(checked))
                            Accessible.role: Accessible.CheckBox
                            Accessible.name: r.name
                            Accessible.checked: checked
                            indicator: Rectangle {
                                implicitWidth: 44
                                implicitHeight: 24
                                x: 0
                                y: parent.height / 2 - height / 2
                                radius: height / 2
                                color: toggle.checked ? Theme.accent : Theme.borderStrong
                                border.width: toggle.visualFocus ? 2 : 0
                                border.color: Theme.focusRing
                                Rectangle {
                                    x: toggle.checked ? parent.width - width - 3 : 3
                                    y: 3
                                    width: 18
                                    height: 18
                                    radius: 9
                                    color: toggle.checked ? Theme.accentOn : Theme.surfaceRaised
                                    Behavior on x { enabled: groupRoot.kit.animate; NumberAnimation { duration: Theme.durationFast } }
                                }
                            }
                            contentItem: Item {}
                        }
                        ComboBox {
                            id: choice
                            objectName: "choice"
                            visible: r.control === "choice"
                            model: r.options
                            textRole: "label"
                            currentIndex: r.current
                            activeFocusOnTab: true
                            implicitWidth: 160
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeBody.size * groupRoot.fs
                            onActivated: groupRoot.kit.edit(r.key, r.options[currentIndex].value)
                            Accessible.role: Accessible.ComboBox
                            Accessible.name: r.name
                        }
                        TextField {
                            id: entry
                            objectName: "setting-field"
                            visible: r.control === "field"
                            text: r.value
                            implicitWidth: 144
                            inputMethodHints: r.numeric ? Qt.ImhFormattedNumbersOnly : Qt.ImhNone
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeBody.size * groupRoot.fs
                            color: Theme.textStrong
                            activeFocusOnTab: true
                            onEditingFinished: if (text !== r.value) groupRoot.kit.edit(r.key, text)
                            Accessible.role: Accessible.EditableText
                            Accessible.name: r.name
                            background: Rectangle {
                                radius: Theme.radiusControl < 0 ? height / 2 : Theme.radiusControl
                                color: Theme.surfaceRaised
                                border.width: entry.activeFocus ? 2 : 1
                                border.color: entry.activeFocus ? Theme.focusRing : Theme.borderSubtle
                            }
                        }
                        // Radio rows (Replace a device, licenses): the chosen one carries a check.
                        KitGlyph {
                            visible: r.radio && r.selected
                            name: "check"
                            size: 18 * groupRoot.fs
                            color: Theme.textStrong
                            Accessible.ignored: true
                        }

                        // The width the buttons need on one line (never shown).
                        RowButtons {
                            id: measure
                            row: r
                            visible: false
                        }
                        // Row actions at the end of the line, or start-aligned on their own row.
                        RowButtons {
                            objectName: "row-actions"
                            row: r
                            solo: rowItem.lone
                            visible: r.actions.length > 0 && !rowItem.stacked
                            Layout.fillWidth: rowItem.lone
                            Layout.maximumWidth: rowItem.lone ? body.width : body.width * 0.55
                        }
                    }

                    // A radio row is one control: arrows and Space pick it, a click picks it.
                    MouseArea {
                        anchors.fill: parent
                        enabled: r.radio && r.enabled
                        z: -1
                        onClicked: groupRoot.kit.select(r.id)
                    }
                    Keys.onPressed: (e) => {
                        if (!(r.radio && r.enabled)) return
                        if (e.key === Qt.Key_Space || e.key === Qt.Key_Return || e.key === Qt.Key_Enter) {
                            groupRoot.kit.select(r.id); e.accepted = true
                        }
                    }
                    activeFocusOnTab: r.radio && r.enabled
                    Accessible.role: r.radio ? Accessible.RadioButton : Accessible.ListItem
                    Accessible.name: r.radio ? r.name : r.title
                    Accessible.description: r.radio ? r.meta : ""
                    Accessible.checked: r.selected
                    Accessible.focusable: r.radio && r.enabled
                    Rectangle {
                        anchors.fill: parent
                        anchors.margins: 2
                        visible: rowItem.activeFocus
                        color: "transparent"
                        radius: 14
                        border.width: 2
                        border.color: Theme.focusRing
                    }
                }
            }
        }
    }
}
