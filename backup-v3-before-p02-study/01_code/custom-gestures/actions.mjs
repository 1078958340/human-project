export const actionNames = Object.freeze({
  next_page: '下一页',
  previous_page: '上一页',
  toggle_gesture_control: '暂停／恢复手势翻页',
});

export function createActionDispatcher({nextPage, previousPage, onEnabledChange = () => {}}) {
  let enabled = true;
  function dispatch({actionId}) {
    if (actionId === null) return {status: 'unbound', enabled};
    if (actionId === 'toggle_gesture_control') {
      enabled = !enabled;
      onEnabledChange(enabled);
      return {status: 'executed', enabled};
    }
    if (!Object.hasOwn(actionNames, actionId)) throw new Error('未知功能 ID。');
    if (!enabled) return {status: 'paused', enabled};
    const changed = actionId === 'next_page' ? nextPage() : previousPage();
    return {status: changed === false ? 'page_boundary' : 'executed', enabled};
  }
  return {dispatch, get enabled() { return enabled; }};
}
