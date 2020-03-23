import Transformable from './core/Transformable';
import { AnimationEasing } from './animation/easing';
import Animator from './animation/Animator';
import { ZRenderType } from './zrender';
import { VectorArray, add } from './core/vector';
import { Dictionary, ElementEventName, ZRRawEvent, BuiltinTextPosition, AllPropTypes } from './core/types';
import Path from './graphic/Path';
import BoundingRect from './core/BoundingRect';
import Eventful, {EventQuery, EventCallback} from './core/Eventful';
import RichText from './graphic/RichText';
import { calculateTextPosition, TextPositionCalculationResult } from './contain/text';
import Storage from './Storage';
import {
    guid,
    isObject,
    keys,
    extend,
    indexOf,
    logError,
    isString,
    mixin,
    isFunction,
    isArrayLike
} from './core/util';

interface TextConfig {
    /**
     * Position relative to the element bounding rect
     * @default 'inside'
     */
    position?: BuiltinTextPosition | number[] | string[]

    /**
     * Rotation of the label.
     */
    rotation?: number

    /**
     * Offset of the label.
     * The difference of offset and position is that it will be applied
     * in the rotation
     */
    offset?: number[]

    /**
     * Distance to the rect
     * @default 5
     */
    distance?: number

    /**
     * If use local user space. Which will apply host's transform
     * @default false
     */
    local?: boolean

    /**
     * Will be set to textContent.style.fill if position is inside
     * If value is 'auto'. It will calculate text fill based on the
     * position and fill of Path.
     */
    insideFill?: string

    /**
     * Will be set to textContent.style.stroke if position is inside
     * If value is 'auto'. It will calculate text stroke based on the
     * position and fill of Path.
     */
    insideStroke?: string
    // TODO applyClip
}

export interface ElementEvent {
    type: ElementEventName,
    event: ZRRawEvent,
    // target can only be an element that is not silent.
    target: Element,
    // topTarget can be a silent element.
    topTarget: Element,
    cancelBubble: boolean,
    offsetX: number,
    offsetY: number,
    gestureEvent: string,
    pinchX: number,
    pinchY: number,
    pinchScale: number,
    wheelDelta: number,
    zrByTouch: boolean,
    which: number,
    stop: (this: ElementEvent) => void
}

export type ElementEventCallback<Ctx, Impl> = (
    this: CbThis<Ctx, Impl>, e: ElementEvent
) => boolean | void
type CbThis<Ctx, Impl> = unknown extends Ctx ? Impl : Ctx;

interface ElementEventHandlerProps {
    // Events
    onclick: ElementEventCallback<unknown, unknown>
    ondblclick: ElementEventCallback<unknown, unknown>
    onmouseover: ElementEventCallback<unknown, unknown>
    onmouseout: ElementEventCallback<unknown, unknown>
    onmousemove: ElementEventCallback<unknown, unknown>
    onmousewheel: ElementEventCallback<unknown, unknown>
    onmousedown: ElementEventCallback<unknown, unknown>
    onmouseup: ElementEventCallback<unknown, unknown>
    oncontextmenu: ElementEventCallback<unknown, unknown>

    ondrag: ElementEventCallback<unknown, unknown>
    ondragstart: ElementEventCallback<unknown, unknown>
    ondragend: ElementEventCallback<unknown, unknown>
    ondragenter: ElementEventCallback<unknown, unknown>
    ondragleave: ElementEventCallback<unknown, unknown>
    ondragover: ElementEventCallback<unknown, unknown>
    ondrop: ElementEventCallback<unknown, unknown>

}

export interface ElementProps extends Partial<ElementEventHandlerProps> {
    name?: string
    ignore?: boolean
    isGroup?: boolean
    draggable?: boolean

    silent?: boolean
    // From transform
    position?: VectorArray
    rotation?: number
    scale?: VectorArray
    origin?: VectorArray
    globalScaleRatio?: number

    textConfig?: TextConfig
    textContent?: RichText

    clipPath?: Path
    drift?: Element['drift']

    // For echarts animation.
    anid?: string
}

// Properties can be used in state.
export const PRESERVED_NORMAL_STATE = '__zr_normal__';

export type ElementStatePropNames = 'position' | 'rotation' | 'scale' | 'origin' | 'textConfig' | 'ignore';
export type ElementState = Pick<ElementProps, ElementStatePropNames>;

const PRIMARY_STATES_KEYS = ['position', 'scale', 'rotation', 'origin', 'ignore'] as const;

type AnimationCallback = () => {}

let tmpTextPosCalcRes = {} as TextPositionCalculationResult;
let tmpBoundingRect = new BoundingRect();

interface Element<Props extends ElementProps = ElementProps> extends Transformable, Eventful, ElementEventHandlerProps {
    // Provide more typed event callback params for mouse events.
    on<Ctx>(event: ElementEventName, handler: ElementEventCallback<Ctx, this>, context?: Ctx): this
    on<Ctx>(event: string, handler: EventCallback<Ctx, this>, context?: Ctx): this

    on<Ctx>(event: ElementEventName, query: EventQuery, handler: ElementEventCallback<Ctx, this>, context?: Ctx): this
    on<Ctx>(event: string, query: EventQuery, handler: EventCallback<Ctx, this>, context?: Ctx): this
}

class Element<Props extends ElementProps = ElementProps> {

    id: number = guid()
    /**
     * Element type
     */
    type: string

    /**
     * Element name
     */
    name: string

    /**
     * If ignore drawing and events of the element object
     */
    ignore: boolean

    /**
     * Whether to respond to mouse events.
     */
    silent: boolean

    /**
     * 是否是 Group
     */
    isGroup: boolean

    /**
     * Whether it can be dragged.
     */
    draggable: boolean | string

    /**
     * Whether is it dragging.
     */
    dragging: boolean

    parent: Element

    animators: Animator<any>[] = [];

    /**
     * ZRender instance will be assigned when element is associated with zrender
     */
    __zr: ZRenderType

    /**
     * Dirty flag. From which painter will determine if this displayable object needs brush.
     */
    __dirty: boolean

    __storage: Storage
    /**
     * path to clip the elements and its children, if it is a group.
     * @see http://www.w3.org/TR/2dcontext/#clipping-region
     */
    private _clipPath: Path

    /**
     * Attached text element.
     * `position`, `style.textAlign`, `style.textVerticalAlign`
     * of element will be ignored if textContent.position is set
     */
    private _textContent: RichText

    /**
     * Config of textContent. Inlcuding layout, color, ...etc.
     */
    textConfig: TextConfig

    // FOR ECHARTS
    /**
     * Id for mapping animation
     */
    anid: string

    currentStates?: string[] = []
    /**
     * Store of element state.
     * '__normal__' key is preserved for default properties.
     */
    states: Dictionary<ElementState> = {}
    protected _normalState: ElementState

    // Temporary storage for inside text color configuration.
    private _insideTextColor: { fill?: string, stroke?: string, lineWidth?: number }

    constructor(props?: Props) {
        // Transformable needs position, rotation, scale
        Transformable.call(this);
        Eventful.call(this);

        this._init(props);
    }

    protected _init(props?: Props) {
        // Init default properties
        this.attr(props);
    }

    /**
     * Drift element
     * @param {number} dx dx on the global space
     * @param {number} dy dy on the global space
     */
    drift(dx: number, dy: number, e?: ElementEvent) {
        switch (this.draggable) {
            case 'horizontal':
                dy = 0;
                break;
            case 'vertical':
                dx = 0;
                break;
        }

        let m = this.transform;
        if (!m) {
            m = this.transform = [1, 0, 0, 1, 0, 0];
        }
        m[4] += dx;
        m[5] += dy;

        this.decomposeTransform();
        this.markRedraw();
    }

    /**
     * Hook before update
     */
    beforeUpdate() {}
    /**
     * Hook after update
     */
    afterUpdate() {}
    /**
     * Update each frame
     */
    update() {
        this.updateTransform();
        this._updateInnerText();
    }

    private _updateInnerText() {
        // Update textContent
        const textEl = this._textContent;
        if (textEl) {
            if (!this.textConfig) {
                this.textConfig = {};
            }
            const textConfig = this.textConfig;
            const isLocal = textConfig.local;
            tmpBoundingRect.copy(this.getBoundingRect());
            if (!isLocal) {
                tmpBoundingRect.applyTransform(this.transform);
            }
            else {
                // TODO parent is always be group for developers. But can be displayble inside.
                textEl.parent = this as unknown as Element;
            }
            calculateTextPosition(tmpTextPosCalcRes, textConfig, tmpBoundingRect);
            // TODO Not modify el.position?
            textEl.position[0] = tmpTextPosCalcRes.x;
            textEl.position[1] = tmpTextPosCalcRes.y;

            textEl.rotation = textConfig.rotation || 0;

            let textOffset = textConfig.offset;
            if (textOffset) {
                add(textEl.position, textEl.position, textOffset);
                textEl.origin = [-textOffset[0], -textOffset[1]];
            }

            if (tmpTextPosCalcRes.textAlign) {
                textEl.style.textAlign = tmpTextPosCalcRes.textAlign;
            }
            if (tmpTextPosCalcRes.verticalAlign) {
                textEl.style.verticalAlign = tmpTextPosCalcRes.verticalAlign;
            }

            // Calculate text color
            const hasInsideFill = textConfig.insideFill != null;
            const hasInsideStroke = textConfig.insideStroke != null;
            if (hasInsideFill || hasInsideStroke) {
                const position = textConfig.position;
                const isInside = typeof position === 'string' && position.indexOf('inside') >= 0;

                if (isInside) {
                    const insideTextColor = this._insideTextColor || (this._insideTextColor = {});

                    let fillColor = textConfig.insideFill;
                    let strokeColor = textConfig.insideStroke;

                    if (fillColor === 'auto') {
                        fillColor = this.getInsideTextFill();
                    }
                    if (strokeColor === 'auto') {
                        strokeColor = this.getInsideTextStroke(fillColor);
                    }

                    insideTextColor.fill = fillColor;
                    insideTextColor.stroke = strokeColor || null;
                    insideTextColor.lineWidth = strokeColor ? 2 : 0;

                    textEl.setDefaultTextColor(insideTextColor);
                }
            }
            else {
                // Clear
                textEl.setDefaultTextColor(null);
            }


            // Mark textEl to update transform.
            textEl.markRedraw();
        }
    }

    protected getInsideTextFill() {
        return '#fff';
    }

    protected getInsideTextStroke(textFill?: string) {
        return '#000';
    }

    traverse<Context>(
        cb: (this: Context, el: Element<Props>) => void,
        context?: Context
    ) {}

    protected attrKV(key: string, value: unknown) {
        if (key === 'position' || key === 'scale' || key === 'origin') {
            // Copy the array
            if (value) {
                let target = this[key];
                if (!target) {
                    target = this[key] = [];
                }
                target[0] = (value as VectorArray)[0];
                target[1] = (value as VectorArray)[1];
            }
        }
        else if (key === 'textConfig') {
            this.setTextConfig(value as TextConfig);
        }
        else if (key === 'textContent') {
            this.setTextContent(value as RichText);
        }
        else if (key === 'clipPath') {
            this.setClipPath(value as Path);
        }
        else {
            (this as any)[key] = value;
        }
    }

    /**
     * Hide the element
     */
    hide() {
        this.ignore = true;
        this.__zr && this.__zr.refresh();
    }

    /**
     * Show the element
     */
    show() {
        this.ignore = false;
        this.__zr && this.__zr.refresh();
    }

    attr(keyOrObj: Props): this
    attr<T extends keyof Props>(keyOrObj: T, value: Props[T]): this
    attr(keyOrObj: keyof Props | Props, value?: unknown): this {
        if (typeof keyOrObj === 'string') {
            this.attrKV(keyOrObj as keyof ElementProps, value as AllPropTypes<ElementProps>);
        }
        else if (isObject(keyOrObj)) {
            let obj = keyOrObj as object;
            let keysArr = keys(obj);
            for (let i = 0; i < keysArr.length; i++) {
                let key = keysArr[i];
                this.attrKV(key as keyof ElementProps, keyOrObj[key]);
            }
        }
        this.markRedraw();
        return this;
    }

    // Save current state to normal
    protected saveStateToNormal() {
        let state = this._normalState;
        if (!state) {
            state = this._normalState = {};
        }

        // TODO clone?
        state.textConfig = this.textConfig;
        state.position = this.position;
        state.scale = this.scale;
        state.rotation = this.rotation;
        state.origin = this.origin || [0, 0];

        state.ignore = this.ignore;
    }

    /**
     * If has any state.
     */
    hasState() {
        return this.currentStates.length > 0;
    }

    /**
     * Get state object
     */
    getState(name: string) {
        return this.states[name];
    }


    /**
     * Ensure state exists. If not, will create one and return.
     */
    ensureState(name: string) {
        const states = this.states;
        if (!states[name]) {
            states[name] = {};
        }
        return states[name];
    }

    /**
     * Clear all states.
     */
    clearStates() {
        this.useState(PRESERVED_NORMAL_STATE);
        // TODO set _normalState to null?
    }
    /**
     * Use state. State is a collection of properties.
     * Will return current state object if state exists and stateName has been changed.
     *
     * @param stateName State name to be switched to
     * @param keepCurrentState If keep current states.
     *      If not, it will inherit from the normal state.
     */
    useState(stateName: string, keepCurrentStates?: boolean) {
        // Use preserved word __normal__
        const toNormalState = stateName === PRESERVED_NORMAL_STATE;

        if (!this.hasState()) {
            // If switched from normal state to other state.
            if (!toNormalState) {
                this.saveStateToNormal();
            }
            else {
                // If switched from normal to normal.
                return;
            }
        }

        const currentStates = this.currentStates;
        const currentStatesCount = currentStates.length;
        const lastStateName = currentStates[currentStatesCount - 1];
        const stateNoChange = stateName === lastStateName
            /// If not keepCurrentStates and has more than one states have been applied.
            // Needs clear all the previous states and applied the new one again.
            && (keepCurrentStates || currentStatesCount === 1);

        if (stateNoChange) {
            return;
        }

        const statesMap = this.states;
        const state = (statesMap && statesMap[stateName]);
        if (!state && !toNormalState) {
            logError(`State ${stateName} not exists.`);
            return;
        }

        this._applyStateObj(state, keepCurrentStates);

        // Also set text content.
        if (this._textContent) {
            this._textContent.useState(stateName);
        }

        if (toNormalState) {
            // Clear state
            this.currentStates = [];
        }
        else {
            if (!keepCurrentStates) {
                this.currentStates = [stateName];
            }
            else {
                this.currentStates.push(stateName);
            }
        }

        this.markRedraw();
        // Return used state.
        return state;
    }

    /**
     * Apply multiple states.
     */
    useStates(states: string[]) {
        for (let i = 0; i < states.length; i++) {
            this.useState(states[i], i > 0);
        }
    }

    protected _applyStateObj(state?: ElementState, keepCurrentStates?: boolean) {
        const normalState = this._normalState;
        let needsRestoreToNormal = !state || !keepCurrentStates;

        // TODO: Save current state to normal?
        // TODO: Animation
        if (state && state.textConfig) {
            // Inherit from current state or normal state.
            this.textConfig = extend(
                {},
                keepCurrentStates ? this.textConfig : normalState.textConfig
            );
            extend(this.textConfig, state.textConfig);
        }
        else if (needsRestoreToNormal) {
            this.textConfig = normalState.textConfig;
        }

        for (let i = 0; i < PRIMARY_STATES_KEYS.length; i++) {
            let key = PRIMARY_STATES_KEYS[i];
            if (state && state[key] != null) {
                // Replace if it exist in target state
                (this as any)[key] = state[key];
            }
            else if (needsRestoreToNormal) {
                // Restore to normal state
                (this as any)[key] = normalState[key];
            }
        }

    }

    /**
     * Get clip path
     */
    getClipPath() {
        return this._clipPath;
    }

    /**
     * Set clip path
     */
    setClipPath(clipPath: Path) {
        const zr = this.__zr;
        if (zr) {
            // Needs to add self to zrender. For rerender triggering, or animation.
            clipPath.addSelfToZr(zr);
        }

        // Remove previous clip path
        if (this._clipPath && this._clipPath !== clipPath) {
            this.removeClipPath();
        }

        this._clipPath = clipPath;
        clipPath.__zr = zr;
        // TODO
        clipPath.__clipTarget = this as unknown as Element;

        this.markRedraw();
    }

    /**
     * Remove clip path
     */
    removeClipPath() {
        const clipPath = this._clipPath;
        if (clipPath) {
            if (clipPath.__zr) {
                clipPath.removeSelfFromZr(clipPath.__zr);
            }

            clipPath.__zr = null;
            clipPath.__clipTarget = null;
            this._clipPath = null;

            this.markRedraw();
        }
    }

    /**
     * Get attached text content.
     */
    getTextContent(): RichText {
        return this._textContent;
    }

    /**
     * Attach text on element
     */
    setTextContent(textEl: RichText) {
        // Remove previous clip path
        if (this._textContent && this._textContent !== textEl) {
            this.removeTextContent();
        }

        const zr = this.__zr;
        if (zr) {
            // Needs to add self to zrender. For rerender triggering, or animation.
            textEl.addSelfToZr(zr);
        }

        this._textContent = textEl;
        textEl.__zr = zr;

        this.markRedraw();
    }

    /**
     * Remove attached text element.
     */
    removeTextContent() {
        const textEl = this._textContent;
        if (textEl) {
            if (textEl.__zr) {
                textEl.removeSelfFromZr(textEl.__zr);
            }
            textEl.__zr = null;
            this._textContent = null;
            this.markRedraw();
        }
    }

    /**
     * Set layout of attached text. Will merge with the previous.
     */
    setTextConfig(cfg: TextConfig) {
        // TODO hide cfg property?
        if (!this.textConfig) {
            this.textConfig = {};
        }
        extend(this.textConfig, cfg);
        this.markRedraw();
    }

    /**
     * Mark element needs to be repainted
     */
    markRedraw() {
        this.__dirty = true;
        this.__zr && this.__zr.refresh();
    }


    /**
     * Besides marking elements to be refreshed.
     * It will also invalid all cache and doing recalculate next frame.
     */
    dirty() {
        this.markRedraw();
    }

    /**
     * Add self from zrender instance.
     * Not recursively because it will be invoked when element added to storage.
     */
    addSelfToZr(zr: ZRenderType) {
        this.__zr = zr;
        // 添加动画
        const animators = this.animators;
        if (animators) {
            for (let i = 0; i < animators.length; i++) {
                zr.animation.addAnimator(animators[i]);
            }
        }

        if (this._clipPath) {
            this._clipPath.addSelfToZr(zr);
        }
        if (this._textContent) {
            this._textContent.addSelfToZr(zr);
        }
    }

    /**
     * Remove self from zrender instance.
     * Not recursively because it will be invoked when element added to storage.
     */
    removeSelfFromZr(zr: ZRenderType) {
        this.__zr = null;
        // 移除动画
        const animators = this.animators;
        if (animators) {
            for (let i = 0; i < animators.length; i++) {
                zr.animation.removeAnimator(animators[i]);
            }
        }

        if (this._clipPath) {
            this._clipPath.removeSelfFromZr(zr);
        }
        if (this._textContent) {
            this._textContent.removeSelfFromZr(zr);
        }
    }

    /**
     * 动画
     *
     * @param path The key to fetch value from object. Mostly style or shape.
     * @param loop Whether to loop animation.
     * @example:
     *     el.animate('style', false)
     *         .when(1000, {x: 10} )
     *         .done(function(){ // Animation done })
     *         .start()
     */
    animate(key?: string, loop?: boolean) {
        let target = key ? (this as any)[key] : this;

        if (!target) {
            logError(
                'Property "'
                + key
                + '" is not existed in element '
                + this.id
            );
            return;
        }

        const animator = new Animator(target, loop);
        this.addAnimator(animator, key);
        return animator;
    }

    addAnimator(animator: Animator<any>, key: string): void {
        const zr = this.__zr;

        const el = this;
        const animators = el.animators;

        // TODO Can improve performance?
        animator.during(function () {
            el.updateDuringAnimation(key as string);
        }).done(function () {
            // FIXME Animator will not be removed if use `Animator#stop` to stop animation
            animators.splice(indexOf(animators, animator), 1);
        });

        animators.push(animator);

        // If animate after added to the zrender
        if (zr) {
            zr.animation.addAnimator(animator);
        }
    }

    updateDuringAnimation(key: string) {
        this.markRedraw();
    }

    /**
     * 停止动画
     * @param {boolean} forwardToLast If move to last frame before stop
     */
    stopAnimation(forwardToLast?: boolean) {
        const animators = this.animators;
        const len = animators.length;
        for (let i = 0; i < len; i++) {
            animators[i].stop(forwardToLast);
        }
        this.animators = [];

        return this;
    }

    /**
     * Caution: this method will stop previous animation.
     * So do not use this method to one element twice before
     * animation starts, unless you know what you are doing.
     *
     * @example
     *  // Animate position
     *  el.animateTo({
     *      position: [10, 10]
     *  }, function () { // done })
     *
     *  // Animate shape, style and position in 100ms, delayed 100ms, with cubicOut easing
     *  el.animateTo({
     *      shape: {
     *          width: 500
     *      },
     *      style: {
     *          fill: 'red'
     *      }
     *      position: [10, 10]
     *  }, 100, 100, 'cubicOut', function () { // done })
     */

    // Overload definitions
    animateTo(target: Props): void
    animateTo(target: Props, callback: AnimationCallback): void
    animateTo(target: Props, time: number, delay: number): void
    animateTo(target: Props, time: number, easing: AnimationEasing): void
    animateTo(target: Props, time: number, callback: AnimationCallback): void
    animateTo(target: Props, time: number, delay: number, callback: AnimationCallback): void
    animateTo(target: Props, time: number, easing: AnimationEasing, callback: AnimationCallback): void
    animateTo(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback): void
    // eslint-disable-next-line
    animateTo(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback, forceAnimate: boolean): void

    // TODO Return animation key
    animateTo(
        target: Props,
        time?: number | AnimationCallback,  // Time in ms
        delay?: AnimationEasing | number | AnimationCallback,
        easing?: AnimationEasing | number | AnimationCallback,
        callback?: AnimationCallback,
        forceAnimate?: boolean // Prevent stop animation and callback
                                // immediently when target values are the same as current values.
    ) {
        animateTo(this, target, time, delay, easing, callback, forceAnimate);
    }

    /**
     * Animate from the target state to current state.
     * The params and the return value are the same as `this.animateTo`.
     */

    // Overload definitions
    animateFrom(target: Props): void
    animateFrom(target: Props, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, delay: number): void
    animateFrom(target: Props, time: number, easing: AnimationEasing): void
    animateFrom(target: Props, time: number, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, delay: number, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, easing: AnimationEasing, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback): void
    // eslint-disable-next-line
    animateFrom(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback, forceAnimate: boolean): void

    animateFrom(
        target: Props,
        time?: number | AnimationCallback,
        delay?: AnimationEasing | number | AnimationCallback,
        easing?: AnimationEasing | number | AnimationCallback,
        callback?: AnimationCallback,
        forceAnimate?: boolean
    ) {
        animateTo(this, target, time, delay, easing, callback, forceAnimate, true);
    }

    /**
     * Interface of getting the minimum bounding box.
     */
    getBoundingRect(): BoundingRect {
        return null;
    }

    protected static initDefaultProps = (function () {
        const elProto = Element.prototype;
        elProto.type = 'element';
        elProto.name = '';
        elProto.ignore = false;
        elProto.silent = false;
        elProto.isGroup = false;
        elProto.draggable = false;
        elProto.dragging = false;
        elProto.__dirty = true;
    })()
}

mixin(Element, Eventful);
mixin(Element, Transformable);

function animateTo<T>(
    animatable: Element<T>,
    target: Dictionary<any>,
    time: number | AnimationCallback,
    delay: AnimationEasing | number | AnimationCallback,
    easing: AnimationEasing | number | AnimationCallback,
    callback: AnimationCallback,
    forceAnimate: boolean,
    reverse?: boolean
) {
    // animateTo(target, time, easing, callback);
    if (isString(delay)) {
        callback = easing as AnimationCallback;
        easing = delay as AnimationEasing;
        delay = 0;
    }
    // animateTo(target, time, delay, callback);
    else if (isFunction(easing)) {
        callback = easing as AnimationCallback;
        easing = 'linear';
        delay = 0;
    }
    // animateTo(target, time, callback);
    else if (isFunction(delay)) {
        callback = delay as AnimationCallback;
        delay = 0;
    }
    // animateTo(target, callback)
    else if (isFunction(time)) {
        callback = time as AnimationCallback;
        time = 500;
    }
    // animateTo(target)
    else if (!time) {
        time = 500;
    }
    // Stop all previous animations
    animatable.stopAnimation();
    animateToShallow(animatable, '', animatable, target, time as number, delay as number, reverse);

    // Animators may be removed immediately after start
    // if there is nothing to animate
    const animators = animatable.animators;
    let count = animators.length;
    function done() {
        count--;
        if (!count) {
            callback && callback();
        }
    }

    // No animators. This should be checked before animators[i].start(),
    // because 'done' may be executed immediately if no need to animate.
    if (!count) {
        callback && callback();
    }
    // Start after all animators created
    // Incase any animator is done immediately when all animation properties are not changed
    for (let i = 0; i < animators.length; i++) {
        animators[i]
            .done(done)
            .start(<AnimationEasing>easing, forceAnimate);
    }
}

/**
 * @example
 *  // Animate position
 *  el._animateToShallow({
 *      position: [10, 10]
 *  })
 *
 *  // Animate shape, style and position in 100ms, delayed 100ms
 *  el._animateToShallow({
 *      shape: {
 *          width: 500
 *      },
 *      style: {
 *          fill: 'red'
 *      }
 *      position: [10, 10]
 *  }, 100, 100)
 */
function animateToShallow<T>(
    animatable: Element<T>,
    topKey: string,
    source: Dictionary<any>,
    target: Dictionary<any>,
    time: number,
    delay: number,
    reverse: boolean    // If `true`, animate from the `target` to current state.
) {
    const animatableKeys: string[] = [];
    const targetKeys = keys(target);
    for (let k = 0; k < targetKeys.length; k++) {
        const innerKey = targetKeys[k] as string;

        if (source[innerKey] != null) {
            if (isObject(target[innerKey]) && !isArrayLike(target[innerKey])) {
                if (topKey) {
                    throw new Error('Only support 1 depth nest object animation.');
                }
                animateToShallow(
                    animatable,
                    innerKey,
                    source[innerKey],
                    target[innerKey],
                    time,
                    delay,
                    reverse
                );
            }
            else {
                animatableKeys.push(innerKey);
            }
        }
        else if (target[innerKey] != null && !reverse) {
            // Assign directly.
            source[innerKey] = target[innerKey];
        }
    }

    const keyLen = animatableKeys.length;

    if (keyLen > 0) {
        let reversedTarget: Dictionary<any>;
        if (reverse) {
            reversedTarget = {};
            for (let i = 0; i < keyLen; i++) {
                let innerKey = animatableKeys[i];
                reversedTarget[innerKey] = source[innerKey];
                // Animate from target
                source[innerKey] = target[innerKey];
            }
        }

        const animator = new Animator(source, false);
        animator.whenWithKeys(
            time == null ? 500 : time,
            reverse ? reversedTarget : target,
            animatableKeys
        ).delay(delay || 0);
        animatable.addAnimator(animator, topKey);
    }
}


export default Element;