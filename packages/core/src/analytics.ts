import type { Unsubscribe } from '@reduxjs/toolkit';
import { AppState, AppStateStatus, Linking } from 'react-native';
import type { Persistor } from 'redux-persist';
import { getContext } from './context';

import {
  applyRawEventData,
  createAliasEvent,
  createGroupEvent,
  createIdentifyEvent,
  createScreenEvent,
  createTrackEvent,
} from './events';
import type { Logger } from './logger';
import type { DestinationPlugin, PlatformPlugin, Plugin } from './plugin';
import { InjectContext } from './plugins/Context';
import { SegmentDestination } from './plugins/SegmentDestination';
import type { Settable, Storage, Watchable } from './storage';
import type { UserInfoState } from './store/userInfo';
import { Timeline } from './timeline';
import {
  Config,
  Context,
  DeepPartial,
  GroupTraits,
  JsonMap,
  PluginType,
  SegmentAPIIntegrations,
  SegmentAPISettings,
  SegmentEvent,
  UserTraits,
} from './types';
import { getPluginsWithFlush } from './util';
import { getUUID } from './uuid';

export class SegmentClient {
  // the config parameters for the client - a merge of user provided and default options
  private config: Config;

  // Storage
  private store: Storage;

  // persistor for the redux store
  private persistor: Persistor;

  // how many seconds has elapsed since the last time events were sent
  private secondsElapsed: number = 0;

  // current app state
  private appState: AppStateStatus | 'unknown' = 'unknown';

  // subscription for propagating changes to appState
  private appStateSubscription: any;

  // logger
  public logger: Logger;

  // internal time to know when to flush, ticks every second
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  // Watcher for isReady updates to the storage
  private readinessWatcher?: Unsubscribe = undefined;

  // unsubscribe watchers for the redux store
  private watchers: Unsubscribe[] = [];

  // whether the user has called cleanup
  private destroyed: boolean = false;

  // has a pending upload to respond
  private isPendingUpload: boolean = false;

  private isAddingPlugins: boolean = false;

  private timeline: Timeline;

  // mechanism to prevent adding plugins before we are fully initalised
  private isStorageReady = false;
  private pluginsToAdd: Plugin[] = [];

  private isInitialized = false;

  get platformPlugins() {
    const plugins: PlatformPlugin[] = [];

    // add context plugin as well as it's platform specific internally.
    // this must come first.
    plugins.push(new InjectContext());

    // setup lifecycle if desired
    if (this.config.trackAppLifecycleEvents) {
      // todo: more plugins!
    }

    return plugins;
  }

  // Watchables
  /**
   * Access or subscribe to client context
   */
  readonly context: Watchable<DeepPartial<Context> | undefined> &
    Settable<DeepPartial<Context>>;

  /**
   * Access or subscribe to adTrackingEnabled (also accesible from context)
   */
  readonly adTrackingEnabled: Watchable<boolean>;

  /**
   * Access or subscribe to integration settings
   */
  readonly settings: Watchable<SegmentAPIIntegrations | undefined>;

  /**
   * Access or suscribe to the events in the timeline
   */
  readonly events: Watchable<SegmentEvent[]>;

  /**
   * Access or subscribe to user info (anonymousId, userId, traits)
   */
  readonly userInfo: Watchable<UserInfoState>;

  /**
   * Returns the plugins currently loaded in the timeline
   * @param ofType Type of plugins, defaults to all
   * @returns List of Plugin objects
   */
  getPlugins(ofType?: PluginType): readonly Plugin[] {
    const plugins = { ...this.timeline.plugins };
    if (ofType !== undefined) {
      return [...(plugins[ofType] ?? [])];
    }
    return (
      [
        ...this.getPlugins(PluginType.before),
        ...this.getPlugins(PluginType.enrichment),
        ...this.getPlugins(PluginType.utility),
        ...this.getPlugins(PluginType.destination),
        ...this.getPlugins(PluginType.after),
      ] ?? []
    );
  }

  /**
   * Retrieves a copy of the current client configuration
   */
  getConfig() {
    return { ...this.config };
  }

  getPersistor() {
    return this.persistor;
  }

  constructor({
    config,
    logger,
    store,
    persistor,
  }: {
    config: Config;
    logger: Logger;
    store: any;
    persistor: Persistor;
  }) {
    this.logger = logger;
    this.config = config;
    this.store = store;
    this.persistor = persistor;
    this.timeline = new Timeline();

    // add segment destination plugin unless
    // asked not to via configuration.
    if (this.config.autoAddSegmentDestination) {
      const segmentDestination = new SegmentDestination();
      this.add({ plugin: segmentDestination });
    }

    // Setup platform specific plugins
    this.platformPlugins.forEach((plugin) => this.add({ plugin: plugin }));

    // Initialize the watchables
    this.context = {
      get: this.store.context.get,
      set: this.store.context.set,
      onChange: this.store.context.onChange,
    };

    this.adTrackingEnabled = {
      get: () => this.store.context.get()?.device?.adTrackingEnabled ?? false,
      onChange: (callback: (value: boolean) => void) =>
        this.store.context.onChange((context?: DeepPartial<Context>) => {
          callback(context?.device?.adTrackingEnabled ?? false);
        }),
    };

    this.settings = {
      get: this.store.settings.get,
      onChange: this.store.settings.onChange,
    };

    this.userInfo = {
      get: this.store.userInfo.get,
      onChange: this.store.userInfo.onChange,
    };

    this.events = {
      get: this.store.events.get,
      onChange: this.store.events.onChange,
    };
  }

  /**
   * Initializes the client plugins, settings and subscribers.
   * Can only be called once.
   */
  async init() {
    if (this.isInitialized) {
      this.logger.warn('SegmentClient already initialized');
      return;
    }

    // Plugin interval check
    if (this.store.isReady.get()) {
      this.onStorageReady(true);
    } else {
      this.store.isReady.onChange((value) => this.onStorageReady(value));
    }

    await this.fetchSettings();

    // flush any stored events
    this.flush();

    // set up the timer/subscription for knowing when to flush events
    this.setupInterval();
    this.setupStorageSubscribers();

    // set up tracking for lifecycle events
    this.setupLifecycleEvents();

    // check if the app was opened from a deep link
    await this.trackDeepLinks();

    // save the current installed version
    await this.checkInstalledVersion();

    this.isInitialized = true;
  }

  async fetchSettings() {
    const settingsEndpoint = `https://cdn-settings.segment.com/v1/projects/${this.config.writeKey}/settings`;

    try {
      const res = await fetch(settingsEndpoint);
      const resJson = await res.json();
      this.logger.info(`Received settings from Segment succesfully.`);
      this.store.settings.set(resJson);
    } catch {
      this.logger.warn(
        `Could not receive settings from Segment. ${
          this.config.defaultSettings
            ? 'Will use the default settings.'
            : 'Device mode destinations will be ignored unless you specify default settings in the client config.'
        }`
      );
      if (this.config.defaultSettings) {
        this.store.settings.set(this.config.defaultSettings);
      }
    }
  }

  /**
   * Clears all subscriptions to the redux store
   */
  private unsubscribeStorageWatchers() {
    if (this.watchers.length > 0) {
      for (const unsubscribe of this.watchers) {
        try {
          unsubscribe();
        } catch (e) {
          this.logger.error(e);
        }
      }
    }
  }

  /**
   * There is no garbage collection in JS, which means that any listeners, timeouts and subscriptions
   * would run until the application closes
   *
   * This method exists in case the user for some reason needs to recreate the class instance during runtime.
   * In this case, they should run client.cleanup() to destroy the listeners in the old client before creating a new one.
   *
   * There is a Stage 3 EMCAScript proposal to add a user-defined finalizer, which we could potentially switch to if
   * it gets approved: https://github.com/tc39/proposal-weakrefs#finalizers
   */
  cleanup() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    this.unsubscribeReadinessWatcher();
    this.unsubscribeStorageWatchers();

    this.appStateSubscription?.remove();

    this.destroyed = true;
    this.isInitialized = false;
  }

  private setupInterval() {
    if (this.flushInterval !== null && this.flushInterval !== undefined) {
      clearInterval(this.flushInterval);
    }
    this.flushInterval = setInterval(() => this.tick(), 1000) as any;
  }

  private setupStorageSubscribers() {
    this.unsubscribeStorageWatchers();

    this.watchers.push(
      this.store.events.onChange((events: SegmentEvent[]) => {
        if (events.length >= this.config.flushAt!) {
          this.flush();
        }
      })
    );
  }

  private setupLifecycleEvents() {
    this.appStateSubscription?.remove();

    this.appStateSubscription = AppState.addEventListener(
      'change',
      (nextAppState) => {
        this.handleAppStateChange(nextAppState);
      }
    );
  }

  /**
     Applies the supplied closure to the currently loaded set of plugins.
     NOTE: This does not apply to plugins contained within DestinationPlugins.

     - Parameter closure: A closure that takes an plugin to be operated on as a parameter.

  */
  apply(closure: (plugin: Plugin) => void) {
    this.timeline.apply(closure);
  }

  /**
   * Adds a new plugin to the currently loaded set.
   * @param {{ plugin: Plugin, settings?: SegmentAPISettings }} Plugin to be added. Settings are optional if you want to force a configuration instead of the Segment Cloud received one
   */
  add({
    plugin,
    settings,
  }: {
    plugin: Plugin;
    settings?: Plugin extends DestinationPlugin ? SegmentAPISettings : never;
  }) {
    // plugins can either be added immediately or
    // can be cached and added later during the next state update
    // this is to avoid adding plugins before network requests made as part of setup have resolved
    if (settings !== undefined && plugin.type === PluginType.destination) {
      this.store.settings.add((plugin as DestinationPlugin).key, settings);
    }

    if (!this.isStorageReady) {
      this.pluginsToAdd.push(plugin);
    } else {
      this.addPlugin(plugin);
    }
  }

  private addPlugin(plugin: Plugin) {
    plugin.configure(this);
    this.timeline.add(plugin);
  }

  /**
     Removes and unloads plugins with a matching name from the system.

     - Parameter pluginName: An plugin name.
  */
  remove({ plugin }: { plugin: Plugin }) {
    this.timeline.remove(plugin);
  }

  process(incomingEvent: SegmentEvent) {
    const event = applyRawEventData(incomingEvent, this.store.userInfo.get());
    this.timeline.process(event);
  }

  private async trackDeepLinks() {
    const url = await Linking.getInitialURL();

    if (url && this.getConfig().trackDeepLinks) {
      const event = createTrackEvent({
        event: 'Deep Link Opened',
        properties: {
          url,
        },
      });
      this.process(event);
      this.logger.info('TRACK (Deep Link Opened) event saved', event);
    }
  }

  private unsubscribeReadinessWatcher() {
    this.readinessWatcher?.();
  }

  private onStorageReady(isReady: boolean) {
    if (isReady && this.pluginsToAdd.length > 0 && !this.isAddingPlugins) {
      this.isAddingPlugins = true;
      try {
        // start by adding the plugins
        this.pluginsToAdd.forEach((plugin) => {
          this.addPlugin(plugin);
        });

        // now that they're all added, clear the cache
        // this prevents this block running for every update
        this.pluginsToAdd = [];

        // finally set the flag which means plugins will be added + registered immediately in future
        this.isStorageReady = true;
        this.unsubscribeReadinessWatcher();
      } finally {
        this.isAddingPlugins = false;
      }
    }
  }

  private tick() {
    if (this.secondsElapsed + 1 >= this.config.flushInterval!) {
      this.flush();
    } else {
      this.secondsElapsed += 1;
    }
  }

  async flush() {
    if (!this.isPendingUpload) {
      this.isPendingUpload = true;
      try {
        if (this.destroyed) {
          return;
        }

        this.secondsElapsed = 0;
        const events = this.store.events.get();

        if (events.length > 0) {
          getPluginsWithFlush(this.timeline).forEach((plugin) =>
            plugin.flush()
          );
        }
      } finally {
        this.isPendingUpload = false;
      }
    }
  }

  screen(name: string, options?: JsonMap) {
    const event = createScreenEvent({
      name,
      properties: options,
    });

    this.process(event);
    this.logger.info('SCREEN event saved', event);
  }

  track(eventName: string, options?: JsonMap) {
    const event = createTrackEvent({
      event: eventName,
      properties: options,
    });

    this.process(event);
    this.logger.info('TRACK event saved', event);
  }

  identify(userId: string, userTraits?: UserTraits) {
    const userInfo = this.store.userInfo.get();
    const { traits: currentUserTraits } = userInfo;

    const mergedTraits = {
      ...currentUserTraits,
      ...userTraits,
    };

    const event = createIdentifyEvent({
      userTraits: mergedTraits,
    });

    this.store.userInfo.set({
      ...userInfo,
      userId: userId,
      traits: mergedTraits,
    });

    this.process(event);
    this.logger.info('IDENTIFY event saved', event);
  }

  group(groupId: string, groupTraits?: GroupTraits) {
    const event = createGroupEvent({
      groupId,
      groupTraits,
    });

    this.process(event);
    this.logger.info('GROUP event saved', event);
  }

  alias(newUserId: string) {
    const { anonymousId, userId } = this.userInfo.get();
    const event = createAliasEvent({
      anonymousId,
      userId,
      newUserId,
    });

    this.store.userInfo.set({
      ...this.store.userInfo.get(),
      userId: newUserId,
    });

    this.process(event);
    this.logger.info('ALIAS event saved', event);
  }

  queueEvent(event: SegmentEvent) {
    this.store.events.add(event);
  }

  removeEvents(event: SegmentEvent | SegmentEvent[]) {
    this.store.events.remove(event);
  }

  /**
   * Called once when the client is first created
   *
   * Detect and save the the currently installed application version
   * Send application lifecycle events if trackAppLifecycleEvents is enabled
   *
   * Exactly one of these events will be sent, depending on the current and previous version:s
   * Application Installed - no information on the previous version, so it's a fresh install
   * Application Updated - the previous detected version is different from the current version
   * Application Opened - the previously detected version is same as the current version
   */
  private async checkInstalledVersion() {
    const context = await getContext(undefined);
    const previousContext = this.store.context.get();

    this.store.context.set(context);

    if (!this.config.trackAppLifecycleEvents) {
      return;
    }

    if (previousContext?.app === undefined) {
      const event = createTrackEvent({
        event: 'Application Installed',
        properties: {
          version: context.app.version,
          build: context.app.build,
        },
      });
      this.process(event);
      this.logger.info('TRACK (Application Installed) event saved', event);
    } else if (context.app.version !== previousContext.app.version) {
      const event = createTrackEvent({
        event: 'Application Updated',
        properties: {
          version: context.app.version,
          build: context.app.build,
          previous_version: previousContext.app.version,
          previous_build: previousContext.app.build,
        },
      });
      this.process(event);
      this.logger.info('TRACK (Application Updated) event saved', event);
    }

    const event = createTrackEvent({
      event: 'Application Opened',
      properties: {
        from_background: false,
        version: context.app.version,
        build: context.app.build,
      },
    });
    this.process(event);
    this.logger.info('TRACK (Application Opened) event saved', event);
  }

  /**
   * AppState event listener. Called whenever the app state changes.
   *
   * Send application lifecycle events if trackAppLifecycleEvents is enabled.
   *
   * Application Opened - only when the app state changes from 'inactive' or 'background' to 'active'
   *   The initial event from 'unknown' to 'active' is handled on launch in checkInstalledVersion
   * Application Backgrounded - when the app state changes from 'inactive' or 'background' to 'active
   *
   * @param nextAppState 'active', 'inactive', 'background' or 'unknown'
   */
  private handleAppStateChange(nextAppState: AppStateStatus) {
    if (this.config.trackAppLifecycleEvents) {
      if (
        ['inactive', 'background'].includes(this.appState) &&
        nextAppState === 'active'
      ) {
        const context = this.store.context.get();
        const event = createTrackEvent({
          event: 'Application Opened',
          properties: {
            from_background: true,
            version: context?.app?.version,
            build: context?.app?.build,
          },
        });
        this.process(event);
        this.logger.info('TRACK (Application Opened) event saved', event);
      } else if (
        this.appState === 'active' &&
        ['inactive', 'background'].includes(nextAppState)
      ) {
        const event = createTrackEvent({
          event: 'Application Backgrounded',
        });
        this.process(event);
        this.logger.info('TRACK (Application Backgrounded) event saved', event);
      }
    }

    this.appState = nextAppState;
  }

  reset() {
    this.store.userInfo.set({
      anonymousId: getUUID(),
      userId: undefined,
      traits: undefined,
    });
    this.logger.info('Client has been reset');
  }
}
