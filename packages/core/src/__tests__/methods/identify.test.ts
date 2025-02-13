import { SegmentClient } from '../../analytics';
import { getMockLogger } from '../__helpers__/mockLogger';
import { mockPersistor } from '../__helpers__/mockPersistor';
import { MockSegmentStore } from '../__helpers__/mockSegmentStore';

jest.mock('../../uuid');

jest
  .spyOn(Date.prototype, 'toISOString')
  .mockReturnValue('2010-01-01T00:00:00.000Z');

describe('methods #identify', () => {
  const initialUserInfo = {
    traits: {
      name: 'Stacy',
      age: 30,
    },
    userId: 'current-user-id',
    anonymousId: 'very-anonymous',
  };
  const store = new MockSegmentStore({
    userInfo: initialUserInfo,
  });

  const clientArgs = {
    config: {
      writeKey: 'mock-write-key',
    },
    logger: getMockLogger(),
    persistor: mockPersistor,
    store: store,
  };

  beforeEach(() => {
    store.reset();
    jest.clearAllMocks();
  });

  it('adds the identify event correctly', () => {
    const client = new SegmentClient(clientArgs);
    jest.spyOn(client, 'process');

    client.identify('new-user-id', { name: 'Mary', age: 30 });

    const expectedEvent = {
      traits: {
        name: 'Mary',
        age: 30,
      },
      type: 'identify',
    };

    expect(client.process).toHaveBeenCalledTimes(1);
    expect(client.process).toHaveBeenCalledWith(expectedEvent);

    expect(client.userInfo.get()).toEqual({
      ...initialUserInfo,
      userId: 'new-user-id',
      traits: expectedEvent.traits,
    });
  });

  it('does not update user traits when there are no new ones provided', () => {
    const client = new SegmentClient(clientArgs);
    jest.spyOn(client, 'process');

    client.identify('new-user-id');

    const expectedEvent = {
      traits: initialUserInfo.traits,
      type: 'identify',
    };

    expect(client.process).toHaveBeenCalledTimes(1);
    expect(client.process).toHaveBeenCalledWith(expectedEvent);

    expect(client.userInfo.get()).toEqual({
      ...initialUserInfo,
      userId: 'new-user-id',
    });
  });
});
