// Fills the status page from the api's own account of itself. Nothing here is secret: whether the signing secret
// is set is shown as yes or no, never the value.
const set = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

fetch("/api/status")
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error("status"))))
  .then((s) => {
    set("name", s.name);
    document.title = s.name;
    set("status", "Online");
    set("type", s.service_type);
    set("region", s.region);
    set("endpoint", "POST " + s.endpoint_path);
    set("secret", s.signing_secret_set ? "Set by the host" : "Not set: requests are refused until it is");
  })
  .catch(() => set("status", "The api isn't answering"));
