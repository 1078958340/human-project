import {calibrateStudy, evaluateStudy, studyTolerance} from './auto-study.mjs';
import {compactStudyResults, freezeStudy, studyGroups, verifyStudyBundle} from './study-exchange.mjs';

self.onmessage = async ({data}) => {
  const {mode, trajectory, labels} = data;
  try {
    if (mode === 'learn') {
      const result = calibrateStudy(trajectory, data.profile, labels, studyTolerance, {allPositives: true});
      const bundle = await freezeStudy(result, trajectory, studyTolerance);
      const {positives, skippedPositives, proposedNegatives, accepted, skippedNegatives} = result;
      self.postMessage({
        report: compactStudyResults(result), bundle,
        samples: {positives, skippedPositives, proposedNegatives, accepted, skippedNegatives},
      });
    } else if (mode === 'evaluate') {
      const bundle = await verifyStudyBundle(data.bundle, trajectory);
      const result = Object.fromEntries(studyGroups.map(group => [
        group, evaluateStudy(trajectory, bundle.profiles[group], labels, bundle.tolerance),
      ]));
      self.postMessage({report: compactStudyResults(result)});
    } else {
      throw new Error('未知的视频学习操作。');
    }
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
