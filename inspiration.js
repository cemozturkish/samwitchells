/* Builds inspiration cards from data/inspiration.json entries.
   Shared by inspiration.html (the public page) and admin.html (the editor). */

const INSPO_TYPES = {
  album:       { label: 'Album',       linkText: 'Listen', details: 'Artist · 2016' },
  artist:      { label: 'Artist',      linkText: 'Listen', details: 'Genre · Hometown' },
  performance: { label: 'Live',        linkText: 'Watch',  details: 'Artist · Venue, 2019' },
  other:       { label: 'Other',       linkText: 'Visit',  details: 'Director · 1999' }
};

const INSPO_FIELDS = ['type', 'label', 'title', 'subtitle', 'note', 'image', 'link', 'linkText'];

function inspoSafeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '';
}

// imageSrc overrides item.image (the admin uses it to preview unpublished uploads)
function buildInspoCard(item, imageSrc) {
  const type = INSPO_TYPES[item.type] ? item.type : 'other';
  const li = document.createElement('li');
  li.className = 'inspo';
  li.dataset.type = type;

  function add(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    li.appendChild(el);
    return el;
  }

  const cover = document.createElement('div');
  cover.className = 'inspo-cover';
  const src = imageSrc || item.image;
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = item.title || '';
    img.loading = 'lazy';
    // Fall back to the chrome placeholder if the image is missing
    img.addEventListener('error', function () { img.remove(); });
    cover.appendChild(img);
  }
  li.appendChild(cover);

  add('span', 'inspo-type', item.label || INSPO_TYPES[type].label);
  add('h2', 'inspo-title', item.title || '');
  if (item.subtitle) add('p', 'inspo-by', item.subtitle);
  if (item.note) add('p', 'inspo-note', item.note);

  const href = inspoSafeUrl(item.link);
  if (href) {
    const a = add('a', 'inspo-link', item.linkText || INSPO_TYPES[type].linkText);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
  }

  return li;
}
