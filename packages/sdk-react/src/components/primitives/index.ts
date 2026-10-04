// The shared UI primitives every prebuilt Polaris Key component is assembled from. Exported so a
// product building a custom screen can inherit the same themed surfaces + a11y contract
// instead of reimplementing them next to the ones it replaced.

export { MessageScreen, type MessageScreenProps } from "./MessageScreen.js";
export {
  Button,
  primaryStyle,
  secondaryStyle,
  quietStyle,
  type ButtonProps,
  type ButtonVariant,
} from "./buttons.js";
export {
  Panel,
  actionGrid,
  actionPanel,
  bannerStyle,
  chipStyle,
  titleText,
  dangerText,
  fullWindow,
  messageCard,
  mutedText,
  panelCard,
  type PanelProps,
} from "./card.js";
export { focusRing, useFocusRing, type FocusRing } from "./focus.js";
export {
  TextField,
  inputStyle,
  labelStyle,
  type TextFieldProps,
} from "./input.js";
