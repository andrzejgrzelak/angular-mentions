import {AfterViewInit, ComponentFactoryResolver, Directive, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, TemplateRef, ViewContainerRef} from '@angular/core';

import {MentionConfig} from './mention-config';
import {MentionListComponent} from './mention-list.component';
import {findInputRecursive, getCaretPosition, getValue, insertValue, setCaretPosition} from './mention-utils';

const KEY_BACKSPACE = 8;
const KEY_TAB = 9;
const KEY_ENTER = 13;
const KEY_SHIFT = 16;
const KEY_ESCAPE = 27;
const KEY_SPACE = 32;
const KEY_LEFT = 37;
const KEY_UP = 38;
const KEY_RIGHT = 39;
const KEY_DOWN = 40;
const KEY_BUFFERED = 229;

/**
 * Angular 2 Mentions.
 * https://github.com/dmacfarlane/angular-mentions
 *
 * Copyright (c) 2017 Dan MacFarlane
 */
@Directive({
  selector: '[mention], [mentionConfig]',
  host: {
    '(keydown)': 'keyHandler($event)',
    '(keypress)': 'keyPressHandler($event)',
    '(textInput)': 'textInputHandler($event)',
    '(blur)': 'blurHandler($event)'
  }
})
export class MentionDirective implements OnChanges, AfterViewInit {

  // stores the items passed to the mentions directive and used to populate the root items in mentionConfig
  private mentionItems: any[];

  @Input('mention') set mention(items: any[]) {
    this.mentionItems = items;
  }

  // the provided configuration object
  @Input() mentionConfig: MentionConfig = {items: []};

  private activeConfig: MentionConfig;// = this.DEFAULT_CONFIG;

  private DEFAULT_CONFIG: MentionConfig = {
    items: [],
    triggerChar: '@',
    labelKey: 'label',
    maxItems: -1,
    debugEvents: false,
    mentionSelect: (item: any) => this.activeConfig.triggerChar + item[this.activeConfig.labelKey]
  }

  // template to use for rendering list items
  @Input() mentionListTemplate: TemplateRef<any>;

  // event emitted whenever the search term changes
  @Output() searchTerm = new EventEmitter();

  // option to diable internal filtering. can be used to show the full list returned
  // from an async operation (or allows a custom filter function to be used - in future)
  @Input() set mentionDisableSearch(disableSearch: boolean) {
    this.disableSearch = disableSearch;
  }

  disableSearch = false;


  private triggerChars: { [key: string]: MentionConfig } = {};

  searchString: string;
  startPos: number;
  startNode;
  searchList: MentionListComponent;
  stopSearch: boolean;
  lastKeyCode: number;
  iframe: any; // optional

  constructor(
    private _element: ElementRef,
    private _componentResolver: ComponentFactoryResolver,
    private _viewContainerRef: ViewContainerRef
  ) {

  }


  ngOnChanges(changes: SimpleChanges) {
    // console.log('config change', changes);
    if (changes['mention'] || changes['mentionConfig']) {
      this.updateConfig();
    }
  }

  ngAfterViewInit(): void {
    this._element = new ElementRef(findInputRecursive(this._element.nativeElement));
  }

  private updateConfig() {
    let config = this.mentionConfig;
    this.triggerChars = {};
    // use items from directive if they have been set
    if (this.mentionItems) {
      config.items = this.mentionItems;
    }
    this.addConfig(config);
    // nested configs
    if (config.mentions) {
      config.mentions.forEach(config => this.addConfig(config));
    }
  }

  // add configuration for a trigger char
  private addConfig(config: MentionConfig) {
    // defaults
    let defaults = Object.assign({}, this.DEFAULT_CONFIG);
    config = Object.assign(defaults, config);
    // items
    let items = config.items;
    if (items && items.length > 0) {
      // convert strings to objects
      if (typeof items[0] == 'string') {
        items = items.map((label) => {
          let object = {};
          object[config.labelKey] = label;
          return object;
        });
      }
      // remove items without an labelKey (as it's required to filter the list)
      items = items.filter(e => e[config.labelKey]);
      if (!config.disableSort) {
        items.sort((a, b) => a[config.labelKey].localeCompare(b[config.labelKey]));
      }
    }
    config.items = items;

    // add the config
    this.triggerChars[config.triggerChar] = config;

    // for async update while menu/search is active
    if (this.activeConfig && this.activeConfig.triggerChar == config.triggerChar) {
      this.activeConfig = config;
      this.updateSearchList();
    }
  }

  // textInput event is fired on android where all keyDown events have keyCode 229
  textInputHandler(event: any, nativeElement: HTMLInputElement = this._element.nativeElement) {
    if (this.activeConfig.debugEvents) {
      // tslint:disable-next-line:no-console
      console.debug('mention.directive textInputHandler:', event);
    }
    nativeElement = this._element.nativeElement;
    if (this.lastKeyCode === KEY_BUFFERED) {
      let keyCode = event.data.charCodeAt(0);
      this.keyHandler({keyCode: keyCode}, nativeElement);
    }
  }

  // keypress event is fired on android where all keyDown events have keyCode 229
  keyPressHandler(event: any, nativeElement: HTMLInputElement = this._element.nativeElement) {
    if (this.activeConfig.debugEvents) {
      // tslint:disable-next-line:no-console
      console.debug('mention.directive keyPressHandler:', event);
    }
  }

  setIframe(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
  }

  stopEvent(event: any) {
    //if (event instanceof KeyboardEvent) { // does not work for iframe
    if (!event.wasClick) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  }

  blurHandler(event: any) {
    if (this.activeConfig.debugEvents) {
      // tslint:disable-next-line:no-console
      console.debug('mention.directive blurHandler:', event);
    }
    this.stopEvent(event);
    this.stopSearch = true;
    if (this.searchList) {
      this.searchList.hidden = true;
    }
  }

  keyHandler(event: any, nativeElement: HTMLInputElement = this._element.nativeElement) {
    if (this.activeConfig.debugEvents) {
      console.debug('mention.directive keyHandler:', event);
    }

    nativeElement = this._element.nativeElement;
    this.lastKeyCode = event.keyCode;
    let val: string = getValue(nativeElement);
    let pos = getCaretPosition(nativeElement, this.iframe);
    let charPressed = event.key;
    if (!charPressed) {
      let charCode = event.which || event.keyCode;
      if (!event.shiftKey && (charCode >= 65 && charCode <= 90)) {
        charPressed = String.fromCharCode(charCode + 32);
      } else {
        // TODO (dmacfarlane) fix this for non-alpha keys
        // http://stackoverflow.com/questions/2220196/how-to-decode-character-pressed-from-jquerys-keydowns-event-handler?lq=1
        charPressed = String.fromCharCode(event.which || event.keyCode);
      }
    }
    if (event.keyCode == KEY_ENTER && event.wasClick && pos < this.startPos) {
      // put caret back in position prior to contenteditable menu click
      pos = this.startNode.length;
      setCaretPosition(this.startNode, pos, this.iframe);
    }
    //console.log("keyHandler", this.startPos, pos, val, charPressed, event);

    let config = this.triggerChars[charPressed];
    if (config) {
      this.activeConfig = config;
      this.startPos = pos;
      this.startNode = (this.iframe ? this.iframe.contentWindow.getSelection() : window.getSelection()).anchorNode;
      this.stopSearch = false;
      this.searchString = null;
      this.clearSearchbox();
      this.showSearchList(nativeElement);
      this.updateSearchList();
    } else if (this.startPos >= 0 && !this.stopSearch) {
      if (pos <= this.startPos) {
        this.searchList.hidden = true;
      }
      // ignore shift when pressed alone, but not when used with another key
      else if (event.keyCode !== KEY_SHIFT &&
        !event.metaKey &&
        !event.altKey &&
        !event.ctrlKey &&
        pos > this.startPos
      ) {
        if (event.keyCode === KEY_SPACE) {
          this.startPos = -1;
        } else if (event.keyCode === KEY_BACKSPACE && pos > 0) {
          pos--;
          if (pos == this.startPos) {
            this.stopSearch = true;
          }
          this.searchList.hidden = this.stopSearch;
        } else if (!this.searchList.hidden) {
          if (event.keyCode === KEY_TAB || event.keyCode === KEY_ENTER) {
            this.stopEvent(event);
            this.searchList.hidden = true;
            this.insertMention(this.searchList.activeItem);
            return false;
          } else if (event.keyCode === KEY_ESCAPE) {
            this.stopEvent(event);
            this.searchList.hidden = true;
            this.stopSearch = true;
            return false;
          } else if (event.keyCode === KEY_DOWN) {
            this.stopEvent(event);
            this.searchList.activateNextItem();
            return false;
          } else if (event.keyCode === KEY_UP) {
            this.stopEvent(event);
            this.searchList.activatePreviousItem();
            return false;
          }
        }

        if (event.keyCode === KEY_LEFT || event.keyCode === KEY_RIGHT) {
          this.stopEvent(event);
          return false;
        } else {
          val = getValue(nativeElement);
          let mention = val.substring(this.startPos + 1, pos);
          if (event.keyCode === KEY_BUFFERED) {
            // We're on soft keyboard so we need to read content from input on next tick
            setTimeout(this.sendSearchTerm.bind(this), 1);
            return;
          }
          if (event.keyCode !== KEY_BACKSPACE) {
            mention += charPressed;
          }
          this.searchString = mention;
          this.searchTerm.emit(this.searchString);
          this.updateSearchList();
        }
      }
    }
  }

  public insertMention(selected: any) {
    const nativeElement = this._element.nativeElement;
    const pos = getCaretPosition(nativeElement, this.iframe);
    // value is inserted without a trailing space for consistency
    // between element types (div and iframe do not preserve the space)
    insertValue(nativeElement, this.startPos, pos,
      this.activeConfig.mentionSelect(selected), this.iframe);
    // fire input event so angular bindings are updated
    if ('createEvent' in document) {
      const evt = document.createEvent('HTMLEvents');
      evt.initEvent('input', false, true);
      nativeElement.dispatchEvent(evt);
    }
    this.startPos = -1;
    this.clearSearchbox();
    this.updateSearchList();
  }

  clearSearchbox() {
    this.activeConfig.items = [];
  }

  sendSearchTerm() {
    const nativeElement = this._element.nativeElement;
    const val = getValue(nativeElement);
    const pos = getCaretPosition(nativeElement, this.iframe);
    this.searchString = val.substring(this.startPos + 1, pos);
    this.searchTerm.emit(this.searchString);
    this.updateSearchList();
  }

  updateSearchList() {
    let matches: any[] = [];
    if (this.activeConfig && this.activeConfig.items) {
      let objects = this.activeConfig.items;
      // disabling the search relies on the async operation to do the filtering
      if (!this.disableSearch && this.searchString) {
        let searchStringLowerCase = this.searchString.toLowerCase();
        objects = objects.filter(e => e[this.activeConfig.labelKey].toLowerCase().startsWith(searchStringLowerCase));
      }
      matches = objects;
      if (this.activeConfig.maxItems > 0) {
        matches = matches.slice(0, this.activeConfig.maxItems);
      }
    }
    // update the search list
    if (this.searchList) {
      this.searchList.labelKey = this.activeConfig.labelKey;
      this.searchList.items = matches;
      this.searchList.hidden = matches.length == 0;
    }
  }

  showSearchList(nativeElement: HTMLInputElement) {
    if (this.searchList == null) {
      let componentFactory = this._componentResolver.resolveComponentFactory(MentionListComponent);
      let componentRef = this._viewContainerRef.createComponent(componentFactory);
      this.searchList = componentRef.instance;
      this.searchList.position(nativeElement, this.iframe, this.activeConfig.dropUp);
      this.searchList.itemTemplate = this.mentionListTemplate;
      componentRef.instance['itemClick'].subscribe(() => {
        nativeElement.focus();
        let fakeKeydown = {'keyCode': KEY_ENTER, 'wasClick': true};
        this.keyHandler(fakeKeydown, nativeElement);
      });
    } else {
      this.searchList.labelKey = this.activeConfig.labelKey;
      this.searchList.activeIndex = 0;
      this.searchList.position(nativeElement, this.iframe, this.activeConfig.dropUp);
      window.setTimeout(() => this.searchList.resetScroll());
    }
    if (this.activeConfig.disableMentionResultbox) {
      this.searchList.display = false;
      return;
    }
  }
}
