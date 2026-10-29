/**
 * Words for the listing's field ids (`shortDescription`, `promotionalText`), so no screen shows a
 * camelCase id to an operator. Unknown ids are split at the capitals and capitalised.
 */

const LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  title: "Title",
  subtitle: "Subtitle",
  shortDescription: "Short description",
  description: "Description",
  promotionalText: "Promotional text",
  keywords: "Keywords",
  features: "Features",
  releaseNotes: "Release notes",
  releaseNotesShort: "Short release notes",
  developerName: "Developer name",
  category: "Category",
  contactEmail: "Contact email",
  copyright: "Copyright",
  fullDescription: "Full description",
  whatsNew: "What's new",
  supportUrl: "Support URL",
  marketingUrl: "Marketing URL",
  privacyUrl: "Privacy URL",
  privacyPolicyUrl: "Privacy policy URL",
  eulaUrl: "EULA URL",
  website: "Website",
  contactWebsite: "Contact website",
  homepage: "Homepage",
};

export function fieldLabel(id: string): string {
  const known = LABELS[id];
  if (known) return known;
  const words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
