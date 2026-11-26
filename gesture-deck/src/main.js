import './style.css';
import { $, icon, notify } from './ui.js';
import { profiles, trajectories, recognizer } from './team-adapter.js';
import { createPresentationDemo } from './mock.js';
import { setupCamera } from './camera.js';
import { setupRehearsal } from './rehearsal.js';
import { setupSlides } from './slides.js';
import { setupPresentation } from './presentation.js';

for (const element of document.querySelectorAll('[data-icon]')) {
  element.innerHTML = icon(element.dataset.icon);
}

const stages = ['record', 'rehearse', 'present'];
let stage;
let personal = profiles.reviseProfile(profiles.createProfile(), {
  gestures: [profiles.createGesture('右滑', 'next_page', 'dynamic')]
}, { kind: 'add_default_gesture' });
let frozen;

const context = {
  personal: () => personal,
  bundle: () => frozen,
  setPersonal(profile) {
    personal = profile;
    rehearsal.updatePersonal();
    presentation.refresh();
  },
  replacePersonal(profile) {
    context.setPersonal(profile);
    camera.refresh();
  },
  setBundle(bundle) {
    frozen = bundle;
    rehearsal.bundleChanged();
    presentation.refresh();
  },
  useC() {
    presentation.refresh('C');
    go('present');
  }
};

const slides = setupSlides();
const camera = setupCamera(context);
const rehearsal = setupRehearsal(context);
const presentation = setupPresentation(slides, context);

function navigate() {
  const requested = location.hash.slice(1);
  const next = stages.includes(requested) ? requested : 'record';
  if (stage === next) return;
  if (stage === 'record') camera.close();
  if (stage === 'rehearse') rehearsal.pause();
  if (stage === 'present') presentation.close();
  stage = next;
  for (const key of stages) {
    $(key).hidden = stage !== key;
    if (stage === key) $('nav-' + key).setAttribute('aria-current', 'step');
    else $('nav-' + key).removeAttribute('aria-current');
  }
  if (stage === 'rehearse') rehearsal.render();
  if (stage === 'present') presentation.render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function go(next) {
  location.hash = next;
  navigate();
}

$('load-demo').onclick = () => {
  try {
    const { profile, track } = createPresentationDemo(profiles, trajectories, recognizer);
    go('present');
    presentation.playDemo(profile, track);
  } catch (error) {
    notify(error.message, true);
  }
};

window.addEventListener('hashchange', navigate);
window.addEventListener('pagehide', () => {
  camera.close();
  rehearsal.cancel();
  presentation.close();
});
navigate();
