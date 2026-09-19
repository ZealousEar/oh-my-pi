// Fixture behaviour: async autocomplete, a control that is replaced after the
// first read, and an enable-on-input button. No framework.
const cities = ["Lisbon", "Lima", "London", "Los Angeles", "Lyon"];
const city = document.getElementById("city");
const list = document.getElementById("city-options");
let timer = null;
city.addEventListener("input", () => {
  if (timer) clearTimeout(timer);
  list.hidden = true;
  city.setAttribute("aria-expanded", "false");
  const query = city.value.trim().toLowerCase();
  if (!query) return;
  // Async population: options arrive one frame-batch later, like a real
  // suggest endpoint.
  timer = setTimeout(() => {
    const matches = cities.filter(name => name.toLowerCase().startsWith(query));
    list.replaceChildren(
      ...matches.map(name => {
        const item = document.createElement("li");
        item.setAttribute("role", "option");
        item.textContent = name;
        item.addEventListener("click", () => {
          city.value = name;
          list.hidden = true;
          city.setAttribute("aria-expanded", "false");
        });
        return item;
      }),
    );
    list.hidden = matches.length === 0;
    city.setAttribute("aria-expanded", matches.length > 0 ? "true" : "false");
  }, 120);
});

// Replace the mover with a fresh node after the first observation reads it, so
// a decision taken against the old node is provably stale.
let replaced = false;
const replaceMover = () => {
  if (replaced) return;
  replaced = true;
  const button = document.createElement("button");
  button.id = "mover";
  button.type = "button";
  button.textContent = "Replaced label";
  document.getElementById("movers").replaceChildren(button);
};
window.__replaceMover = replaceMover;
