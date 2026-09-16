// Push the latest settings/paper types/discount rules to the cloud.
//
// Fire-and-forget: the operator's change is already saved locally, and the
// cloud copy catches up on the next successful sync if this one fails.
export function triggerCloudSettingsSync() {
  import("../services/cloudSync.js")
    .then(({ syncSettings, isEnabled }) => {
      if (isEnabled()) syncSettings().catch(() => {});
    })
    .catch(() => {});
}
