// The live gate: importing the package registers every pk-* element, and
// `<pk-gate config='{"product":"tidewater"}'>` in index.html builds the browser client and runs
// every screen the license calls for. Served from a CDN this file is the one script tag:
//   <script type="module" src="https://key.plrs.im/elements/1/pk.js"></script>
import "@polaris-key/elements";
