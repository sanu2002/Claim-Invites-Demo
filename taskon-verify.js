async function validateQuest(spaceId, accessToken,loggeinaddress='' ,{ sprintId = null } = {}) {
  const query = `
    query GetSpaceLoyaltyRanks($spaceId: Int!, $sprintId: Int, $cursorAfter: String) {
      spaceLoyaltyPointsRanks(spaceId: $spaceId, sprintId: $sprintId, cursorAfter: $cursorAfter) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        list {
          rank
          points
          address {
            username
            address
            avatar
          }
        }
      }
    }
  `;

  // helper to call once (used for pagination)
  const callOnce = async (cursorAfter = null) => {
    const response = await fetch('https://graphigo-business.prd.galaxy.eco/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access-token': accessToken, // if the API expects a different header (e.g. Authorization), change here
      },
      body: JSON.stringify({
        query,
        variables: { spaceId: Number(spaceId), sprintId, cursorAfter },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }

    const json = await response.json();
    if (json.errors?.length) {
      // surface GraphQL errors clearly
      const message = json.errors.map(e => e.message).join(' | ');
      throw new Error(`GraphQL error: ${message}`);
    }

    return json.data.spaceLoyaltyPointsRanks;
  };

  // fetch first page
  const first = await callOnce(null);



 const normalised = loggeinaddress.toLowerCase();

 const userdata=first.list.map(item=>item.address.address=== normalised)

 console.log(userdata)


// const userData = all.list.find(
//   item => item.address.toLowerCase() === normalised
// );








}

console.log(validateQuest("78752","SaVT9mT8SMOaxGRHyHGTpA","0x4BdcB795842B0C029095687f2fD7DD15c52f443D"))

// spaceId
//accessToken : in a env file 